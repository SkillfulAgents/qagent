import type { SetupContext } from 'qagent'

/**
 * Calls httpbin.org/uuid before the test starts and stores the result.
 * Demonstrates how hooks can pre-fetch data and share it via ctx.store.
 */
export default async function fetchUuid(ctx: SetupContext): Promise<void> {
  const res = await fetch(`${ctx.baseUrl}/uuid`)
  if (!res.ok) throw new Error(`GET /uuid failed: ${res.status}`)

  const data = await res.json() as { uuid: string }
  ctx.store.set('uuid', data.uuid)
  console.log(`    Fetched UUID: ${data.uuid}`)
}
