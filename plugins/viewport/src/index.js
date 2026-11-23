// Viewport: in-app remote desktop page, live preview, and takeover controls for self-hosted agents.

import { createClient } from "../../../plugin/src/client.js";
import { createBuzzPrimitives, ui } from "../../../plugin/src/ui.js";
import {
  VIEWPORT_PAGE_ICON,
  VIEWPORT_PAGE_ID,
  createDesktop,
  parseViewportRoute,
  previewKeys,
  validateViewportRoute,
  viewportPageTarget,
} from "../../../plugin/src/desktop.js";
import { isSelfHostedAgent } from "../../../plugin/src/config.js";

export {
  VIEWPORT_PAGE_ICON,
  VIEWPORT_PAGE_ID,
  parseViewportRoute,
  previewKeys,
  validateViewportRoute,
  viewportPageTarget,
};

export const inject = ["react", "agents", "conversation", "pages", "navigation"];

export function apply(ctx) {
  const React = ctx.react;
  const uiKit = ui(React);
  const { Btn, Icon } = createBuzzPrimitives(React);
  const client = createClient();
  ctx.effect(() => () => client.close());

  const pluginId = ctx.pluginOwner?.id ?? "local.buzz-host.viewport";
  const { ViewportPage, DesktopSettings, DesktopPreview } = createDesktop({
    React,
    client,
    ctx,
    uiKit,
    Btn,
    Icon,
    navigation: ctx.navigation,
    pluginId,
  });

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

  // Register top-level Viewport page in Buzz's dock (alongside Agents and Shared notes)
  ctx.pages.register({
    id: VIEWPORT_PAGE_ID,
    title: "Viewport",
    layout: "workspace",
    primary: true,
    placement: "dock",
    icon: VIEWPORT_PAGE_ICON,
    route: {
      version: 1,
      validate: validateViewportRoute,
    },
    component: ViewportPage,
  });

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
