import * as vscode from "vscode";
import * as dgram from 'dgram';
import { LogsProvider, scheme } from "./Logs";
import { traceFunction, traceLine } from "./Tracer";

export async function activate(context: vscode.ExtensionContext) {
  // This exposes logs at the "systemtap-logs:///systemtap.logs" URI
  const logsProvider = new LogsProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(scheme, logsProvider)
  );

  // This listens to UDP packets on a given port and forwards them to the logger
  const port = vscode.workspace.getConfiguration('systemtap-assistant').get('port', 65530);
  const server = dgram.createSocket('udp4');
  server.on('message', (msg) => { logsProvider.ingestPacket(msg); });
  server.bind(port);

  // This adds commands, reachable from the context menu to add cases to the tracing set
  context.subscriptions.push(
    vscode.commands.registerCommand('systemtap-assistant.trace-function', async () => { traceFunction(); }));
  context.subscriptions.push(
    vscode.commands.registerCommand('systemtap-assistant.trace-line', async () => { traceLine(); }));
}
