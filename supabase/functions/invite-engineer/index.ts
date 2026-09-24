import { withSupabase } from 'npm:@supabase/server'

const APP_URL = 'https://mel-bp.github.io/obra-em-dia-web/'

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') return Response.json({ error: 'Método não permitido.' }, { status: 405 })
    try {
      const { email: rawEmail, projectId } = await req.json()
      const email = String(rawEmail || '').trim().toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !projectId) {
        return Response.json({ error: 'Informe um e-mail válido e uma obra.' }, { status: 400 })
      }

      const { data: profile, error: profileError } = await ctx.supabase
        .from('profiles')
        .select('role')
        .eq('id', ctx.userClaims.sub)
        .maybeSingle()
      if (profileError || profile?.role !== 'admin') {
        return Response.json({ error: 'Apenas administradores podem convidar engenheiros.' }, { status: 403 })
      }

      const { data: project, error: projectError } = await ctx.supabaseAdmin
        .from('projects')
        .select('id')
        .eq('id', projectId)
        .maybeSingle()
      if (projectError || !project) {
        return Response.json({ error: 'A obra não foi encontrada.' }, { status: 404 })
      }

      let engineerId: string
      const { data: existing, error: existingError } = await ctx.supabaseAdmin
        .from('profiles')
        .select('id,role')
        .eq('email', email)
        .maybeSingle()
      if (existingError) throw existingError

      if (existing) {
        if (existing.role !== 'engineer') {
          return Response.json({ error: 'Esse e-mail já pertence a uma conta que não é de engenheiro.' }, { status: 409 })
        }
        engineerId = existing.id
      } else {
        const { data, error } = await ctx.supabaseAdmin.auth.admin.inviteUserByEmail(email, {
          redirectTo: APP_URL,
          data: { role: 'engineer' },
        })
        if (error) {
          const reason = String(error.code || error.message || '').toLowerCase()
          const message = reason.includes('email_address_not_authorized') || reason.includes('not authorized')
            ? 'O SMTP padrão do Supabase só envia para membros da organização. Configure um SMTP próprio em Authentication → SMTP Settings para convidar engenheiros externos.'
            : reason.includes('over_email_send_rate_limit') || reason.includes('rate limit')
              ? 'O limite de envio de e-mails do Supabase foi atingido. Aguarde ou configure um SMTP próprio.'
              : reason.includes('already') || reason.includes('registered')
                ? 'Esse e-mail já possui conta no Supabase, mas o perfil de engenheiro não foi localizado. Confira Authentication → Users.'
                : 'O Supabase não conseguiu enviar o convite. Confira a configuração de e-mail e tente novamente.'
          return Response.json({ error: message }, { status: 400 })
        }
        if (!data.user) throw new Error('O convite foi enviado, mas o Supabase não retornou o usuário.')
        engineerId = data.user.id
      }

      const { error: memberError } = await ctx.supabaseAdmin
        .from('project_members')
        .insert({ project_id: projectId, user_id: engineerId, assigned_by: ctx.userClaims.sub })
      if (memberError && memberError.code !== '23505') throw memberError

      return Response.json({ ok: true, invited: !existing, email })
    } catch (error) {
      console.error('invite-engineer failed:', error)
      return Response.json({ error: 'Não foi possível concluir o convite. Verifique se o perfil, a obra e as permissões estão configurados.' }, { status: 500 })
    }
  }),
}
