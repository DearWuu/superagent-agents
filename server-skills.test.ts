/**
 * 随插件注册原生 Skills：id 判重不覆盖、路径保持 skill://、
 * 单个技能或整个 transform 失败只记 `skills-register-failed`，不阻断 setup。
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import plugin, { registerSuperagentSkills } from "./server"

const cleanups: string[] = []

function tempState() {
  const dir = mkdtempSync(path.join(tmpdir(), "superagent-skills-"))
  cleanups.push(dir)
  process.env.SUPERAGENT_STATE_DIR = dir
  process.env.XDG_STATE_HOME = dir
  process.env.SUPERAGENT_HOOK_LOG = path.join(dir, "hook.log")
  return dir
}

afterEach(() => {
  while (cleanups.length > 0) rmSync(cleanups.pop()!, { recursive: true, force: true })
  delete process.env.SUPERAGENT_STATE_DIR
  delete process.env.XDG_STATE_HOME
  delete process.env.SUPERAGENT_HOOK_LOG
})

function hookLog(): any[] {
  try {
    return readFileSync(process.env.SUPERAGENT_HOOK_LOG!, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

function skillCtx(options: { existing?: string[]; failTransform?: boolean; failAddId?: string } = {}) {
  const added: any[] = []
  const logs: any[] = []
  const ctx = {
    skill: {
      transform: async (callback: any) => {
        if (options.failTransform) throw new Error("skill service down")
        const editor = {
          get: (id: string) => (options.existing?.includes(id) ? { id } : undefined),
          add: (skill: any) => {
            if (skill.id === options.failAddId) throw new Error("add failed")
            added.push(skill)
          },
        }
        callback(editor)
        return { dispose() {} }
      },
    },
  }
  return { ctx, added, logs }
}

describe("registerSuperagentSkills", () => {
  test("注册三个技能，路径保持 skill://", async () => {
    tempState()
    const h = skillCtx()
    await registerSuperagentSkills(h.ctx)
    expect(h.added).toHaveLength(3)
    for (const skill of h.added) {
      expect(skill.path).toBe(`skill://${skill.id}/SKILL.md`)
      expect(skill.content.length).toBeGreaterThan(0)
    }
    expect(hookLog().some((record) => record.event === "skills-registered")).toBe(true)
  })

  test("已存在同名技能不覆盖", async () => {
    tempState()
    const h = skillCtx({ existing: ["superagent-orchestration"] })
    await registerSuperagentSkills(h.ctx)
    expect(h.added.map((skill) => skill.id)).not.toContain("superagent-orchestration")
    expect(h.added).toHaveLength(2)
  })

  test("注册服务失败只记 skills-register-failed，不抛出", async () => {
    tempState()
    const h = skillCtx({ failTransform: true })
    await expect(registerSuperagentSkills(h.ctx)).resolves.toBeUndefined()
    expect(hookLog().some((record) => record.event === "skills-register-failed")).toBe(true)
  })

  test("单个技能 add 失败不影响其他技能", async () => {
    tempState()
    const h = skillCtx({ failAddId: "superagent-acceptance" })
    await registerSuperagentSkills(h.ctx)
    expect(h.added.map((skill) => skill.id)).toEqual(["superagent-orchestration", "superagent-context"])
    const failed = hookLog().filter((record) => record.event === "skills-register-failed")
    expect(failed).toHaveLength(1)
    expect(failed[0].skill).toBe("superagent-acceptance")
  })

  test("没有 skill API 时静默跳过", async () => {
    tempState()
    await expect(registerSuperagentSkills({})).resolves.toBeUndefined()
  })
})

describe("setup 注册不依赖协作开关", () => {
  test("collab-enabled=false 时 setup 仍注册技能", async () => {
    tempState()
    const added: any[] = []
    const ctx = {
      tool: { hook: async () => ({ dispose() {} }) },
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {
            return
          },
        }),
      },
      skill: {
        transform: async (callback: any) => {
          callback({ get: () => undefined, add: (skill: any) => added.push(skill) })
          return { dispose() {} }
        },
      },
      session: {
        hook: async () => ({ dispose() {} }),
        async list() {
          return { data: [] }
        },
        async get() {
          return {}
        },
        instructions: { entry: { async list() { return [{ key: "superagent.collab-enabled", value: "false" }] } } },
      },
    }
    const dispose = await (plugin as any).setup(ctx)
    expect(added.map((skill) => skill.id)).toEqual([
      "superagent-orchestration",
      "superagent-acceptance",
      "superagent-context",
    ])
    await dispose()
  })
})