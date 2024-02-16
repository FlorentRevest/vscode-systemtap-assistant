import * as vscode from "vscode";
import { clearMsg } from "./Tracer";

// We always access logs from that URI so we can broadcast updates
export const scheme = "systemtap-logs";
const logsUri = vscode.Uri.parse(scheme + ":///systemtap.log");

export class LogsProvider implements vscode.TextDocumentContentProvider {
  // Every time the buffer is reset, make the first line of logs pop up
  private isFirstLine = true;
  // Accumulate logs over time here
  private logs: string = '';

  onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  onDidChange = this.onDidChangeEmitter.event;

  // Serve logs
  provideTextDocumentContent(_: vscode.Uri): string {
    return this.logs;
  }

  // Add a line at the end of the current logs
  private append(logMessage: string) {
    if (!this.isFirstLine) {
        this.logs += "\n";
    }
    this.logs += logMessage;
    this.onDidChangeEmitter.fire(logsUri);

    // Open the logs buffer if necessary
    if (this.isFirstLine) {
      vscode.workspace.openTextDocument(logsUri).then(doc => {
        vscode.window.showTextDocument(doc);
      });
      this.isFirstLine = false;
    }
  }

  // Resets the logs buffer
  private clearLogs() {
    this.isFirstLine = true;
    this.logs = "";
    this.onDidChangeEmitter.fire(logsUri);
  }

  // Exposed function to ingest raw UDP packets
  ingestPacket(msg: Uint8Array) {
    let msgString = msg.toString().trim();
    if (msgString === clearMsg) {
        this.clearLogs();
    } else {
        this.append(msgString);
    }
  }
}
