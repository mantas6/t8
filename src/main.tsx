/**
 * OpenTUI + Solid smoke test: renders a centered box and exits on `q` or Ctrl-C.
 */
import { render, useKeyboard, useRenderer } from "@opentui/solid";

function App() {
  const renderer = useRenderer();

  useKeyboard((key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      renderer.destroy();
    }
  });

  return (
    <box width="100%" height="100%" alignItems="center" justifyContent="center">
      <box border borderStyle="rounded" padding={1} title=" t3tui ">
        <text>t3tui</text>
        <text fg="#888888">press q to quit</text>
      </box>
    </box>
  );
}

await render(() => <App />, { exitOnCtrlC: true });
