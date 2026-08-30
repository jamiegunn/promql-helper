import type { Playbook } from './types.ts'
import { serviceHealth } from './service-health.ts'
import { resources } from './resources.ts'
import { jvm } from './jvm.ts'
import { database } from './database.ts'
import { redis } from './redis.ts'

/**
 * Order matters — this is the order the questions are offered in, and it runs
 * from "what are users experiencing" outward to "which dependency is at fault",
 * which is the order you would actually investigate an incident in.
 */
export const PLAYBOOKS: Playbook[] = [serviceHealth, resources, jvm, database, redis]

const BY_ID = new Map(PLAYBOOKS.map((p) => [p.id, p]))

export function getPlaybook(id: string): Playbook | undefined {
  return BY_ID.get(id)
}

export type { Playbook, PanelDef, PanelContext, QuerySpec } from './types.ts'
