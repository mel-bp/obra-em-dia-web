import { createClient } from 'npm:@supabase/supabase-js@2'

const APP_URL = 'https://mel-bp.github.io/obra-em-dia-web/'
const allowedOrigin = 'https://mel-bp.github.io'
const corsHeaders = {
  'Access-Control-Allow-Origin': allowedOrigin,
  'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
}
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const normalizeName = (value: string) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR')
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

function invitationError(error: { code?: string; message?: string }) {
  const reason = String(error.code || error.message || '').toLowerCase()
  if (reason.includes('email_address_not_authorized') || reason.includes('not authorized')) return 'O SMTP padrão do Supabase só envia para membros da organização. Configure um SMTP próprio em Authentication → SMTP Settings para convidar engenheiros externos.'
  if (reason.includes('over_email_send_rate_limit') || reason.includes('rate limit')) return 'O limite de envio de e-mails do Supabase foi atingido. Aguarde ou configure um SMTP próprio.'
  if (reason.includes('already') || reason.includes('registered')) return 'Esse e-mail já possui conta, mas o perfil de engenheiro não foi localizado.'
  return 'O Supabase não conseguiu enviar o convite. Confira a configuração de e-mail e tente novamente.'
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Método não permitido.' }, 405)

  try {
    const authHeader = request.headers.get('Authorization') || ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    const url = Deno.env.get('SUPABASE_URL') || ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    if (!token || !url || !anonKey || !serviceKey) return json({ error: 'A autenticação do projeto não está configurada.' }, 500)

    const userClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: authData, error: authError } = await userClient.auth.getUser(token)
    if (authError || !authData.user) return json({ error: 'Entre novamente para cadastrar o projeto.' }, 401)
    const { data: caller, error: callerError } = await admin.from('profiles').select('role').eq('id', authData.user.id).maybeSingle()
    if (callerError || caller?.role !== 'admin') return json({ error: 'Apenas administradores podem cadastrar projetos e convidar engenheiros.' }, 403)

    let payload: { name?: unknown; engineers?: unknown }
    try { payload = await request.json() } catch { return json({ error: 'Não consegui ler os dados do cadastro.' }, 400) }
    const projectName = String(payload.name || '').trim()
    if (!projectName || projectName.length > 180) return json({ error: 'Informe um nome de projeto com até 180 caracteres.' }, 400)
    if (!Array.isArray(payload.engineers) || payload.engineers.length < 1 || payload.engineers.length > 25) return json({ error: 'Informe de 1 a 25 engenheiros responsáveis.' }, 400)

    const engineers: Array<{ name: string; email: string }> = []
    const seen = new Set<string>()
    for (const item of payload.engineers) {
      const candidate = item as { name?: unknown; email?: unknown }
      const name = String(candidate?.name || '').trim()
      const email = String(candidate?.email || '').trim().toLowerCase()
      if (!name || name.length > 120 || !emailPattern.test(email)) return json({ error: 'Confira o nome e o e-mail de cada engenheiro.' }, 400)
      if (seen.has(email)) return json({ error: 'O mesmo e-mail não pode ser informado mais de uma vez.' }, 400)
      seen.add(email)
      engineers.push({ name, email })
    }

    const { data: existingProjects, error: projectsError } = await admin.from('projects').select('id,name,source_file,created_at')
    if (projectsError) throw projectsError
    const matching = (existingProjects || []).filter(project => normalizeName(project.name) === normalizeName(projectName))
      .sort((a, b) => Number(Boolean(b.source_file)) - Number(Boolean(a.source_file)) || (Date.parse(b.created_at || '') || 0) - (Date.parse(a.created_at || '') || 0))
    let project = matching[0] || null
    let created = false
    if (!project) {
      const { data, error } = await admin.from('projects').insert({ name: projectName, created_by: authData.user.id }).select('id,name,source_file,created_at').single()
      if (error) throw error
      project = data
      created = true
    }

    const results: Array<{ name: string; email: string; status: 'invited' | 'associated' | 'error'; message?: string }> = []
    for (const engineer of engineers) {
      try {
        const { data: existing, error: profileError } = await admin.from('profiles').select('id,role').eq('email', engineer.email).maybeSingle()
        if (profileError) throw profileError
        let engineerId: string
        let status: 'invited' | 'associated'
        if (existing) {
          if (existing.role !== 'engineer') {
            results.push({ ...engineer, status: 'error', message: 'Este e-mail já pertence a uma conta que não é de engenheiro.' })
            continue
          }
          engineerId = existing.id
          status = 'associated'
          const { error: nameError } = await admin.from('profiles').update({ display_name: engineer.name }).eq('id', engineerId)
          if (nameError) throw nameError
        } else {
          const { data, error } = await admin.auth.admin.inviteUserByEmail(engineer.email, {
            redirectTo: APP_URL,
            data: { role: 'engineer', full_name: engineer.name },
          })
          if (error) {
            results.push({ ...engineer, status: 'error', message: invitationError(error) })
            continue
          }
          if (!data.user) throw new Error('O convite não retornou o usuário criado.')
          engineerId = data.user.id
          status = 'invited'
          const { error: profileUpsertError } = await admin.from('profiles').upsert(
            { id: engineerId, email: engineer.email, display_name: engineer.name, role: 'engineer' },
            { onConflict: 'id' },
          )
          if (profileUpsertError) throw profileUpsertError
        }

        const { error: memberError } = await admin.from('project_members').upsert(
          { project_id: project.id, user_id: engineerId, assigned_by: authData.user.id },
          { onConflict: 'project_id,user_id', ignoreDuplicates: true },
        )
        if (memberError) throw memberError
        results.push({ ...engineer, status })
      } catch (error) {
        console.error('Falha ao associar engenheiro ao projeto:', error)
        results.push({ ...engineer, status: 'error', message: 'Não foi possível concluir o vínculo deste engenheiro.' })
      }
    }
    return json({ ok: true, projectId: project.id, projectName: project.name, created, results })
  } catch (error) {
    console.error('register-project failed:', error)
    return json({ error: 'Não foi possível cadastrar o projeto. Verifique as permissões e tente novamente.' }, 500)
  }
})
