import * as vscode from "vscode";
import * as path from 'path';
import * as fs from 'fs';

// Magic UDP packet that clears the logs
export const clearMsg = "===CLEAR===";

// This is a default systemtap preamble that provides a tracer() helper that logs info over UDP
function getTracerPreamble(): string {
  const port = vscode.workspace.getConfiguration('systemtap-assistant').get('port', 65530);
  let preamble = `%{
#include <linux/netpoll.h>
#include <linux/etherdevice.h>

// Using Guru-mode, we can send UDP packets in any kernel context thanks to Netpoll
struct netpoll np;
static DEFINE_SPINLOCK(send_udp_lock);

// Freeing the netpoll object must be deferred outside of atomic context
void free_netpoll_worker(struct work_struct *work) { netpoll_cleanup(&np); }
DECLARE_WORK(free_netpoll_work, free_netpoll_worker);
%}

// When loading this tracer, staprun can overwrite the interface to output to
global interface = "eth0";

function create_netpoll() %{
    // Configure Netpoll to broadcast UDP packets on a given ethernet interface
    np.name = "systemtap-tracer";
    np.remote_port = @@PORT@@;
    eth_broadcast_addr(np.remote_mac);
    strscpy(np.dev_name, /* pragma:read:interface */  STAP_GLOBAL_GET_interface(), IFNAMSIZ);
    netpoll_setup(&np);
%}
probe begin {
    create_netpoll();
    send_udp("@@CLEAR_MSG@@");
}
function free_netpoll() %{
    schedule_work(&free_netpoll_work);
%}
probe end {
    free_netpoll();
}

function send_udp(msg:string) %{
    unsigned long flags;
    spin_lock_irqsave(&send_udp_lock, flags);
    netpoll_send_udp(&np, STAP_ARG_msg, strlen(STAP_ARG_msg));
    spin_unlock_irqrestore(&send_udp_lock, flags);
%}

function should_trace() {
    // Only trace if 'current' is a child of the traced task
    parent = task_parent(task_current());
    traced_task = pid2task(target());

    while(parent && task_pid(parent) > 0) {
        if(traced_task == parent)
            return 1;

        parent = task_parent(parent);
    }
}

global indent_counters

function trace_call() {
    if (should_trace()) {
        send_udp(sprintf("%s(%d):%-*s %s(%s) {",
                 execname(), tid(), indent_counters[tid()], "", ppfunc(), $$parms$))
        indent_counters[tid()] += 2
    }
}

function trace_return() {
    if (should_trace()) {
        indent_counters[tid()] -= 2
        send_udp(sprintf("%s(%d):%-*s } // %s = %s",
                 execname(), tid(), indent_counters[tid()], "", ppfunc(), $return$))
    }
}

function trace_line() {
    if (should_trace())
        send_udp(sprintf("%s(%d):%-*s %s:%s %s",
                 execname(), tid(), indent_counters[tid()], "", ppfunc(), symline(addr()), $$locals$))
}`;

  let preamblePath = vscode.workspace.getConfiguration('systemtap-assistant').get('preamble-path', '');
  if (preamblePath !== "") {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length) {
      preamblePath = path.resolve(workspaceFolders[0].uri.fsPath, preamblePath);
    }
    preamble = fs.readFileSync(preamblePath).toString();
  }

  return preamble.replace("@@PORT@@", port.toString()).replace("@@CLEAR_MSG@@", clearMsg);
}

// If the user configured a task to run after script re-generation, run it
async function runDeployTask() {
  const taskName = vscode.workspace.getConfiguration('systemtap-assistant').get<string>('deploy-task');
  if (!taskName) {
    return;
  }

  const allTasks = await vscode.tasks.fetchTasks();
  const taskToRun = allTasks.find(task => task.name === taskName);
  if (!taskToRun) {
    vscode.window.showErrorMessage(`Task not found: ${taskName}`);
    return;
  }

  try {
    vscode.tasks.executeTask(taskToRun);
  } catch (error: any) {
    vscode.window.showErrorMessage(`Failed to execute task ${taskName}: ${error.message}`);
  }
}

// If the output script already exist, add a hook line there. If it doesn't, regenerate it
function appendToScript(line: string) {
  const filePath = vscode.workspace.getConfiguration('systemtap-assistant').get<string>('output', '');

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || !workspaceFolders.length) {
    vscode.window.showErrorMessage(`No workspace open`);
    return;
  }

  const firstFolderUri = workspaceFolders[0].uri;
  const absolutePath = path.resolve(firstFolderUri.fsPath, filePath);

  if (fs.existsSync(absolutePath)) {
    if (fs.readFileSync(absolutePath).includes(line)) {
      vscode.window.showInformationMessage(`This hook is already traced`);
      return;
    }

    fs.appendFileSync(absolutePath, '\n\n' + line);
  } else {
    fs.writeFileSync(absolutePath, getTracerPreamble() + '\n\n' + line);
  }

  runDeployTask();
}

// Find the currently selected line
function currentLine(): { uri: vscode.Uri, nb: number } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage(`No editor open`);
    return;
  }
  return { uri: editor.document.uri, nb: editor.selection.active.line };
}

// Given a file and a line of code, use the document symbol provider to figure out the function name at this line
async function getFunctionNameFromLine(fileUri: vscode.Uri, lineNumber: number): Promise<string | undefined> {
  const documentSymbols: vscode.DocumentSymbol[] = await vscode.commands.executeCommand(
    'vscode.executeDocumentSymbolProvider',
    fileUri
  );

  const position = new vscode.Position(lineNumber, 0);
  for (const symbol of documentSymbols) {
    if (symbol.kind === vscode.SymbolKind.Function && symbol.range.contains(position)) {
      return symbol.name;
    }
  }

  return undefined;
}

// Generate two new lines, to hook at the function entry and return
export async function traceFunction() {
  const line = currentLine();
  if (!line) {
    return;
  }

  const functionName = await getFunctionNameFromLine(line.uri, line.nb);
  if (!functionName) {
    vscode.window.showErrorMessage("Could not determine function name");
    return;
  }

  const callCode = vscode.workspace.getConfiguration('systemtap-assistant').get('call-code', '');
  const returnCode = vscode.workspace.getConfiguration('systemtap-assistant').get('return-code', '');
  const hook = `probe kernel.function("${functionName}").call   { ${callCode} }
probe kernel.function("${functionName}").return { ${returnCode} }`;
  appendToScript(hook);
}

// Generate one new line, to hook at a specific line
export async function traceLine() {
  const line = currentLine();
  if (!line) {
    return;
  }

  let filePath = line.uri.path;
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length) {
    filePath = path.relative(workspaceFolders[0].uri.path, filePath);
  }

  const lineCode = vscode.workspace.getConfiguration('systemtap-assistant').get('line-code', '');
  const hook = `probe kernel.statement("*@${filePath}:${line.nb+1}") { ${lineCode} }`;
  appendToScript(hook);
}