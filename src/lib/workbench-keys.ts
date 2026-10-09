import { commands } from "./commands";
import { markUserAction } from "../state/actions";

/** Shared by the app and the synthetic browser fixture; no startup side effects. */
export function handleWorkbenchKey(event: KeyboardEvent) {
  const command = commands.matchEvent(event);
  if (!command) return;
  const element = event.target as HTMLElement | null;
  if (element?.closest?.(".xterm") && !command.terminalSafe) return;
  event.preventDefault();
  markUserAction();
  void command.run();
}
