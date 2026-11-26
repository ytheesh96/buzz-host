// Remote Agents: a Buzz self-hosted agent type backed by buzz-host.
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
import { createOrchestrator } from "./orchestrator.js";
import { createType } from "./type.js";
import { createServerCard } from "./server-card.js";
import { createInviteFeature } from "./invite.js";

export { catalogKey, catalogParams, composerModels } from "./composer.js";

export const inject = ["react", "agents", "settingsCards", "navigation"];

export function apply(ctx) {
  const React = ctx.react;
  const uiKit = ui(React);
  const { Btn } = createBuzzPrimitives(React);
  const client = createClient();
  ctx.effect(() => () => client.close());

  const relay = ctx.reflect?.get?.("relay");
  const { invalidateCatalog, hostedModels, hostedSessions } = createComposer({ client, ctx });
  const { ActivityTab } = createActivity({ React, ctx, uiKit, relay });
  const { OrchestratorSettings } = createOrchestrator({ React, client, uiKit });
  const { InviteOverlay, InviteMessageCard, matchesInviteMessage } = createInviteFeature({
    React,
    client,
    relay,
    uiKit,
    Btn,
  });

  createType({
    React,
    client,
    ctx,
    uiKit,
    invalidateCatalog,
    ActivityTab,
    OrchestratorSettings,
    hostedModels,
    hostedSessions,
  });

  // ----- Settings → Remote Agents: status card and Shared access -----
  ctx.settingsCards.register({
    id: "server",
    title: "Remote Agents",
    group: "Plugins",
    component: createServerCard({ React, client, uiKit, Btn, relay, navigation: ctx.navigation }),
  });

  // ----- Seamless 1:1 DM invites: inline card + automatic Accept overlay -----
  ctx.inject?.(["conversation"], (scope) => {
    scope.conversation?.registerMessage?.({
      id: "guest-invite",
      title: "Remote Agents invite",
      matches: matchesInviteMessage,
      component: InviteMessageCard,
    });
  });

  // App overlays are available when bundled in Buzz; external installs fall back to the DM card.
  ctx.inject?.(["pages"], (scope) => {
    try {
      scope.pages?.registerOverlay?.({
        id: "guest-invite",
        component: InviteOverlay,
      });
    } catch {
      // External plugin installs cannot register app overlays; inline DM card still works.
    }
  });
}
