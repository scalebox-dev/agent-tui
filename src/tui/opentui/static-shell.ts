import { BoxRenderable, createCliRenderer, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import type { AgentRunOptions } from "../../agent.js";
import { buildWorkbenchRenderModel } from "../../workbench/render-model.js";
import { createInitialWorkbenchState } from "../workbench.js";

export async function renderOpenTuiStaticShell(options: AgentRunOptions): Promise<void> {
  let renderer: Awaited<ReturnType<typeof createCliRenderer>>;
  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: false,
      screenMode: "alternate-screen",
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(
      `OpenTUI renderer is not available in this runtime. Use the default Ink renderer or run with OpenTUI native FFI support. Details: ${details}`,
    );
  }

  const root = new BoxRenderable(renderer, {
    id: "agent-api-opentui-root",
    flexDirection: "column",
    height: "100%",
    padding: 1,
    width: "100%",
  });
  renderer.root.add(root);

  renderStaticShell(renderer, root, options);
  renderer.requestRender();

  await new Promise<void>((resolve) => {
    const close = () => {
      renderer.keyInput.off("keypress", onKeyPress);
      renderer.destroy();
      resolve();
    };
    const onKeyPress = (key: KeyEvent) => {
      if ((key.ctrl && key.name === "c") || key.name === "escape" || key.name === "q") {
        close();
      }
    };
    renderer.keyInput.on("keypress", onKeyPress);
  });
}

function renderStaticShell(
  renderer: Awaited<ReturnType<typeof createCliRenderer>>,
  root: BoxRenderable,
  options: AgentRunOptions,
): void {
  const state = createInitialWorkbenchState({
    accessMode: options.accessMode,
    contextEnabled: Boolean(options.includeLocalContext || options.workdir),
    conversation: options.conversation,
    model: options.model,
    preset: options.preset,
  });
  if (options.workdir) {
    state.workdir = {
      root: options.workdir,
      name: options.workdir.split(/[\\/]/).filter(Boolean).at(-1) || options.workdir,
      fileCount: 0,
      totalBytes: 0,
      scanTruncated: false,
    };
  }

  const model = buildWorkbenchRenderModel({
    draft: "",
    profileName: options.profile || "default",
    spinnerFrame: 0,
    state,
    transcriptOffset: 0,
    viewport: {
      rows: renderer.height,
      columns: renderer.width,
    },
    workdirFallback: options.workdir || process.cwd(),
  });

  const header = new BoxRenderable(renderer, {
    id: "agent-api-opentui-header",
    border: true,
    flexDirection: "column",
    padding: 1,
    title: "Agent API Workbench - OpenTUI Preview",
    width: "100%",
  });
  root.add(header);
  header.add(
    text(
      renderer,
      "agent-api-opentui-header-profile",
      `profile=${model.header.profile} conversation=${model.header.conversation}`,
    ),
  );
  header.add(
    text(renderer, "agent-api-opentui-header-run", `preset=${model.header.preset} model=${model.header.model}`),
  );
  header.add(
    text(
      renderer,
      "agent-api-opentui-header-local",
      `workdir=${model.header.workdir} access=${model.header.accessMode} local_tools=${model.header.contextEnabled ? "on" : "off"}`,
    ),
  );

  const body = new BoxRenderable(renderer, {
    id: "agent-api-opentui-body",
    flexDirection: "row",
    flexGrow: 1,
    marginTop: 1,
    width: "100%",
  });
  root.add(body);

  const transcript = new ScrollBoxRenderable(renderer, {
    id: "agent-api-opentui-transcript",
    border: true,
    flexGrow: 1,
    padding: 1,
    stickyScroll: true,
    stickyStart: "bottom",
    title: "Transcript",
  });
  body.add(transcript);
  for (const line of model.transcript.lines) {
    transcript.add(text(renderer, `agent-api-opentui-transcript-${line.id}`, line.text || " "));
  }

  const activity = new BoxRenderable(renderer, {
    id: "agent-api-opentui-activity",
    border: true,
    flexDirection: "column",
    marginLeft: 1,
    padding: 1,
    title: "Activity",
    width: Math.max(24, Math.floor(model.terminalColumns * 0.25)),
  });
  body.add(activity);
  for (const item of model.visibleActivities) {
    activity.add(
      text(renderer, `agent-api-opentui-activity-${item.id}`, `${new Date(item.timestamp).toLocaleTimeString()} ${item.text}`),
    );
  }

  const footer = new BoxRenderable(renderer, {
    id: "agent-api-opentui-footer",
    border: true,
    marginTop: 1,
    padding: 1,
    width: "100%",
  });
  root.add(footer);
  footer.add(text(renderer, "agent-api-opentui-footer-text", "OpenTUI static renderer spike. Press q, Esc, or Ctrl-C to exit."));
}

function text(
  renderer: Awaited<ReturnType<typeof createCliRenderer>>,
  id: string,
  content: string,
): TextRenderable {
  return new TextRenderable(renderer, {
    id,
    content,
  });
}
