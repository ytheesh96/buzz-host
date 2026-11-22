// Omarchy agents: a Buzz remote agent type backed by buzz-host.
//
// Buzz calls provision → activate (with the owner's NIP-OA attestation) and
// later profile / instructions / remove. buzz-host, on the server, keeps each
// agent's key and runs it with buzz-acp, so agents answer while this computer
// is closed. Transport is JSON over wss:// (tailscale serve), the only
// non-Buzz network scheme the app's CSP allows.

import { createClient } from "./client.js";
import { createBuzzPrimitives, ui } from "./ui.js";
import { createComposer } from "./composer.js";
import { createActivity } from "./activity.js";
import { createDesktop } from "./desktop.js";
import { createOrchestrator } from "./orchestrator.js";
import { createAttention } from "./attention.js";
import { createType } from "./type.js";
import { createServerCard } from "./server-card.js";

export { catalogKey, catalogParams, composerModels } from "./composer.js";

export const inject = ["react", "agents", "settingsCards", "conversation"];

export function apply(ctx) {
  const React = ctx.react;
  const uiKit = ui(React);
  const { Icon, Btn } = createBuzzPrimitives(React);
  const client = createClient();
  ctx.effect(() => () => client.close());

  const relay = ctx.reflect?.get?.("relay");
  const { invalidateCatalog, hostedModels, hostedSessions } = createComposer({ client, ctx });
  const { ActivityTab } = createActivity({ React, ctx, uiKit, relay });
  const { DesktopSettings, DesktopPreview } = createDesktop({ React, client, ctx, uiKit, Btn });
  const { OrchestratorSettings } = createOrchestrator({ React, client, uiKit });
  const { AttentionTab } = createAttention({ React, client, ctx, Btn, Icon, relay });

  createType({
    React,
    client,
    ctx,
    uiKit,
    invalidateCatalog,
    ActivityTab,
    AttentionTab,
    DesktopSettings,
    OrchestratorSettings,
    hostedModels,
    hostedSessions,
  });

  // The in-chat desktop preview, after Buzz's own activity bubble (order 0).
  ctx.conversation.registerAccessory({
    id: "desktop-preview",
    title: "Agent desktop preview",
    placement: "response",
    order: 10,
    component: DesktopPreview,
  });

  // ----- Settings → Omarchy agents: server address and status -----
  ctx.settingsCards.register({
    id: "server",
    title: "Omarchy agents",
    group: "Plugins",
    component: createServerCard({ React, client, uiKit }),
  });
}
