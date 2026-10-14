import { createClient } from 'npm:@supabase/supabase-js@2.57.0'
import webpush from 'npm:web-push@3.6.7'

const APP_URL = 'https://mel-bp.github.io/obra-em-dia-web/'
const VAPID_PUBLIC_KEY = 'BBtoMj-PNwjcJaxWmYzToLm8nmAS61dqZorAnEL2ZhkMOQy4GV98M7BfHAiPrch4Y1Iuor50c8Ksy-rCZ09j5SU'
const json = (body: unknown, status = 200) => Response.json(body, { status })
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) || [], pair => Number.parseInt(pair, 16))
}

Deno.serve(async request => {
  if (request.method !== 'POST') return json({ error: 'Método não permitido.' }, 405)
  const signature = request.headers.get('x-submission-signature') || ''
  if (!/^[0-9a-f]{64}$/i.test(signature)) return json({ error: 'Não autorizado.' }, 401)

  let submissionId: string
  try {
    const body = await request.json()
    submissionId = String(body?.submission_id || '')
  } catch {
    return json({ error: 'Corpo inválido.' }, 400)
  }
  if (!uuidPattern.test(submissionId)) return json({ error: 'Envio inválido.' }, 400)

  const url = Deno.env.get('SUPABASE_URL')
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !serviceKey) return json({ error: 'Serviço indisponível.' }, 503)
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

  const { data: secrets, error: secretsError } = await admin.rpc('get_push_secrets')
  if (secretsError || !secrets?.webhook_secret || !secrets?.vapid_private_key) {
    console.error('Configuração de push indisponível:', secretsError?.message)
    return json({ error: 'Serviço indisponível.' }, 503)
  }

  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secrets.webhook_secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const valid = await crypto.subtle.verify('HMAC', key, hexBytes(signature), new TextEncoder().encode(submissionId))
  if (!valid) return json({ error: 'Não autorizado.' }, 401)

  const { data: submission, error: submissionError } = await admin.from('submissions')
    .select('id,project_id,submitted_by').eq('id', submissionId).maybeSingle()
  if (submissionError) return json({ error: 'Falha ao consultar o envio.' }, 500)
  if (!submission) return json({ error: 'Envio não encontrado.' }, 404)

  const [{ data: engineer, error: engineerError }, { data: project, error: projectError }] = await Promise.all([
    admin.from('profiles').select('role,display_name,email').eq('id', submission.submitted_by).maybeSingle(),
    admin.from('projects').select('name').eq('id', submission.project_id).maybeSingle(),
  ])
  if (engineerError || projectError) return json({ error: 'Falha ao consultar a obra.' }, 500)
  if (engineer?.role !== 'engineer' || !project) return json({ ignored: true })

  const { data: claimed, error: claimError } = await admin.rpc('claim_push_dispatch', { p_submission_id: submissionId })
  if (claimError) return json({ error: 'Falha ao preparar a notificação.' }, 500)
  if (!claimed) return json({ duplicate: true })

  const [{ data: subscriptions, error: subscriptionsError }, { data: admins, error: adminsError }, { data: responsibles, error: responsiblesError }] = await Promise.all([
    admin.from('push_subscriptions').select('id,user_id,endpoint,p256dh,auth_key'),
    admin.from('profiles').select('id').eq('role', 'admin'),
    admin.from('project_admins').select('user_id').eq('project_id', submission.project_id),
  ])
  if (subscriptionsError || adminsError || responsiblesError) return json({ error: 'Falha ao consultar os celulares.' }, 500)

  const adminIds = new Set((admins || []).map(row => row.id))
  const responsibleIds = new Set((responsibles || []).map(row => row.user_id))
  const destinations = (subscriptions || []).filter(row => adminIds.has(row.user_id) && responsibleIds.has(row.user_id))
  const name = engineer.display_name?.trim() || engineer.email || 'Um engenheiro'
  const payload = JSON.stringify({
    title: 'Obra em Dia',
    body: `${name} atualizou ${project.name}.`,
    url: `${APP_URL}?project=${encodeURIComponent(submission.project_id)}`,
    tag: `submission-${submissionId}`,
  })
  webpush.setVapidDetails(APP_URL, VAPID_PUBLIC_KEY, secrets.vapid_private_key)

  let delivered = 0
  let failed = 0
  await Promise.all(destinations.map(async subscription => {
    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth_key },
      }, payload, { TTL: 86400 })
      delivered++
    } catch (error) {
      const status = Number((error as { statusCode?: number })?.statusCode)
      if (status === 404 || status === 410) {
        await admin.from('push_subscriptions').delete().eq('id', subscription.id)
      } else {
        failed++
        console.error('Falha no envio de push:', status || String(error))
      }
    }
  }))

  if (failed === 0) {
    const { error: completedError } = await admin.from('push_dispatches')
      .update({ completed_at: new Date().toISOString() }).eq('submission_id', submissionId)
    if (completedError) return json({ error: 'Falha ao concluir a notificação.' }, 500)
  }
  return json({ delivered, failed }, failed ? 502 : 200)
})
