/**
 * critic 身份只认 marker：标题像复核的普通子代理仍占名额、仍会被淘汰。
 *
 * 复核会话由 marker 标注；标题只是显示名，不能拿来当身份依据。
 */
import { describe, expect, test } from "bun:test"

import { CRITIC_TITLE_PREFIX, isCriticSession } from "./critic"
import { listChildren, pickVictim } from "./server-session"

describe("critic 身份只认 marker", () => {
  test("标题前缀不作身份依据", () => {
    expect(isCriticSession({ title: `${CRITIC_TITLE_PREFIX}普通子代理` })).toBe(false)
    expect(isCriticSession({ metadata: { "superagent.critic": true } })).toBe(true)
  })

  test("标题为复核前缀的普通子代理仍占名额并会被淘汰", async () => {
    const ctx = {
      session: {
        list: async () => ({
          data: [
            {
              id: "ses_titled",
              parentID: "ses_root",
              title: `${CRITIC_TITLE_PREFIX}普通子代理`,
              outcome: "succeeded",
              time: { created: 1, busy: 2, idle: 3 },
            },
            {
              id: "ses_critic",
              parentID: "ses_root",
              title: "普通标题",
              metadata: { "superagent.critic": true },
              outcome: "succeeded",
              time: { created: 1, busy: 2, idle: 3 },
            },
          ],
        }),
      },
    }

    const children = await listChildren(ctx, "ses_root", 100)
    // 复核会话不占名额；标题像复核的普通子代理照常占名额。
    expect(children.map((child) => child.id)).toEqual(["ses_titled"])

    const victim = pickVictim(children, new Set(), new Set())
    expect(victim?.child.id).toBe("ses_titled")
    expect(victim?.reason).toBe("finished")
  })
})
