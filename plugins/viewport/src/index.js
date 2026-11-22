// Viewport: live remote desktop preview, noVNC full screen, and desktop control for self-hosted agents.

import { createClient } from "../../../plugin/src/client.js";
import { createBuzzPrimitives, ui } from "../../../plugin/src/ui.js";
import { createDesktop, previewKeys } from "../../../plugin/src/desktop.js";
import { isSelfHostedAgent } from "../../../plugin/src/config.js";

export { previewKeys };

export const inject = ["react", "agents", "conversation"];

export function apply(ctx) {
  const React = ctx.react;
  const uiKit = ui(React);
  const { Btn } = createBuzzPrimitives(React);
  const client = createClient();
  ctx.effect(() => () => client.close());

  const { DesktopSettings, DesktopPreview } = createDesktop({ React, client, ctx, uiKit, Btn });

  const agentUi = () => {
    try {
      const value = ctx.reflect?.get?.("agentUi");
      return value?.version === 1 ? value : undefined;
    } catch {
      return undefined;
    }
  };

  function DesktopTab({ agent }) {
    const ui = agentUi();
    return React.createElement(
      "div",
      { className: "grid gap-4 [container-type:inline-size]" },
      React.createElement(DesktopSettings, { ui, agent }),
    );
  }

  // Register dedicated Desktop tab on self-hosted agents
  ctx.agents.registerTab({
    id: "desktop",
    title: "Desktop",
    when: (agent) => isSelfHostedAgent(agent),
    component: DesktopTab,
  });

  // In-chat desktop preview accessory
  ctx.conversation.registerAccessory({
    id: "desktop-preview",
    title: "Agent desktop preview",
    placement: "response",
    order: 10,
    component: DesktopPreview,
  });
}
