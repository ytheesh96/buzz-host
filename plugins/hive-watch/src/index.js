// Hive Watch: Watches, triggers, and scheduled Attention for self-hosted agents on buzz-host.

import { createClient } from "../../../plugin/src/client.js";
import { createBuzzPrimitives } from "../../../plugin/src/ui.js";
import { createAttention, plain, schedule, titleOf, words } from "../../../plugin/src/attention.js";
import { isSelfHostedAgent } from "../../../plugin/src/config.js";

export { plain, schedule, titleOf, words };

export const inject = ["react", "agents"];

export function apply(ctx) {
  const React = ctx.react;
  const { Icon, Btn } = createBuzzPrimitives(React);
  const client = createClient();
  ctx.effect(() => () => client.close());

  const relay = ctx.reflect?.get?.("relay");
  const { AttentionTab } = createAttention({ React, client, ctx, Btn, Icon, relay });

  ctx.agents.registerTab({
    id: "attention",
    title: "Attention",
    when: (agent) => isSelfHostedAgent(agent),
    component: AttentionTab,
  });
}
