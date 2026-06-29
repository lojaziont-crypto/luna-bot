require('dotenv').config()

process.on('uncaughtException', (err) => {
    console.error('[ERRO FATAL]', err.message)
})
process.on('unhandledRejection', (err) => {
    console.error('[PROMISE REJEITADA]', err?.message || err)
})

const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const cron = require('node-cron')
const Groq = require('groq-sdk')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

// ─────────────────────────────────────────────────────────────────────────────
// Arquivos de memória e estado
// ─────────────────────────────────────────────────────────────────────────────

const MEMORIA_FILE = path.join(__dirname, 'zeon_memoria.json')
const DECISOES_FILE = path.join(__dirname, 'zeon_decisoes.json')
const PENDENTES_FILE = path.join(__dirname, 'zeon_pendentes.json')

function carregarJSON(arquivo, padrao) {
    try {
        if (fs.existsSync(arquivo)) return JSON.parse(fs.readFileSync(arquivo, 'utf8'))
    } catch {}
    return padrao
}
function salvarJSON(arquivo, dados) {
    fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2))
}

// Memória: estratégias, histórico, aprendizados
let memoria = carregarJSON(MEMORIA_FILE, {
    estrategias: [],          // estratégias que funcionaram
    historico_metas: [],      // resultado diário das metas
    aprendizados: [],         // lições aprendidas
    estrategias_mauricio: [], // estratégias passadas pelo Maurício
    ultima_atualizacao: null
})

// Decisões registradas (para auditoria e aprendizado)
let decisoes = carregarJSON(DECISOES_FILE, [])

// Pendências aguardando autorização do Maurício
let pendentes = carregarJSON(PENDENTES_FILE, {})

// ─────────────────────────────────────────────────────────────────────────────
// Comunicação com a Zaya
// ─────────────────────────────────────────────────────────────────────────────

function notificarZaya(mensagem) {
    const url = process.env.ZAYA_URL
    if (!url) {
        console.log(`⚠️ [Zeon] ZAYA_URL não definida — mensagem não enviada: ${mensagem}`)
        return
    }

    const data = JSON.stringify({ mensagem })
    let parsedUrl
    try { parsedUrl = new URL(`${url}/zeon-notificacao`) } catch {
        console.error(`❌ [Zeon] ZAYA_URL inválida: ${url}`)
        return
    }

    const lib = parsedUrl.protocol === 'https:' ? https : http
    const port = parsedUrl.port ? Number(parsedUrl.port) : (parsedUrl.protocol === 'https:' ? 443 : 80)

    const req = lib.request({
        hostname: parsedUrl.hostname,
        port,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
        console.log(`📨 [Zeon] Zaya notificada (HTTP ${res.statusCode})`)
    })
    req.on('error', err => console.error(`❌ [Zeon] Erro ao notificar Zaya: ${err.message}`))
    req.write(data)
    req.end()
}

// Busca dados do Fin (financeiro) via HTTP
function consultarFin(urlPath) {
    return new Promise((resolve) => {
        const finUrl = process.env.FIN_URL || 'http://localhost:3002'
        let parsedUrl
        try { parsedUrl = new URL(`${finUrl}${urlPath}`) } catch {
            console.error(`❌ [Zeon] FIN_URL inválida`)
            return resolve(null)
        }
        const lib = parsedUrl.protocol === 'https:' ? https : http
        const port = parsedUrl.port ? Number(parsedUrl.port) : 80

        const req = lib.request({
            hostname: parsedUrl.hostname,
            port,
            path: parsedUrl.pathname,
            method: 'GET',
        }, res => {
            let corpo = ''
            res.on('data', chunk => { corpo += chunk })
            res.on('end', () => {
                try { resolve(JSON.parse(corpo)) } catch { resolve(null) }
            })
        })
        req.setTimeout(10000, () => { req.destroy(); resolve(null) })
        req.on('error', () => resolve(null))
        req.end()
    })
}

// Busca dados do Zyon (Shopee) via HTTP
function consultarZyon(urlPath) {
    return new Promise((resolve) => {
        const zyonUrl = process.env.ZYON_URL || 'http://localhost:3001'
        let parsedUrl
        try { parsedUrl = new URL(`${zyonUrl}${urlPath}`) } catch {
            console.error(`❌ [Zeon] ZYON_URL inválida`)
            return resolve(null)
        }
        const lib = parsedUrl.protocol === 'https:' ? https : http
        const port = parsedUrl.port ? Number(parsedUrl.port) : 80

        const req = lib.request({
            hostname: parsedUrl.hostname,
            port,
            path: parsedUrl.pathname,
            method: 'GET',
        }, res => {
            let corpo = ''
            res.on('data', chunk => { corpo += chunk })
            res.on('end', () => {
                try { resolve(JSON.parse(corpo)) } catch { resolve(null) }
            })
        })
        req.setTimeout(10000, () => { req.destroy(); resolve(null) })
        req.on('error', () => resolve(null))
        req.end()
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Pesquisa na web via DuckDuckGo (sem API key)
// ─────────────────────────────────────────────────────────────────────────────

function pesquisarWeb(query) {
    return new Promise((resolve) => {
        const q = encodeURIComponent(query)
        const options = {
            hostname: 'api.duckduckgo.com',
            path: `/?q=${q}&format=json&no_redirect=1&no_html=1&skip_disambig=1`,
            method: 'GET',
            headers: { 'User-Agent': 'Zeon-Ziont-Bot/1.0' }
        }
        const req = https.request(options, res => {
            let corpo = ''
            res.on('data', chunk => { corpo += chunk })
            res.on('end', () => {
                try {
                    const data = JSON.parse(corpo)
                    const partes = []
                    if (data.AbstractText) partes.push(data.AbstractText)
                    if (data.Answer) partes.push(`Resposta direta: ${data.Answer}`)
                    if (data.RelatedTopics) {
                        data.RelatedTopics.slice(0, 6).forEach(t => {
                            if (t.Text) partes.push(t.Text)
                        })
                    }
                    if (data.Results) {
                        data.Results.slice(0, 3).forEach(r => {
                            if (r.Text) partes.push(r.Text)
                        })
                    }
                    resolve(partes.length ? partes.join('\n\n') : 'Nenhum resultado encontrado para esta pesquisa')
                } catch { resolve('Erro ao processar resposta da busca') }
            })
        })
        req.setTimeout(12000, () => { req.destroy(); resolve('Timeout na busca web') })
        req.on('error', () => resolve('Erro de conexão na busca web'))
        req.end()
    })
}

async function pesquisarESalvar(query, contexto) {
    console.log(`🔍 [Zeon] Pesquisando na web: "${query}"`)
    try {
        const resultadoBruto = await pesquisarWeb(query)

        const resposta = await gerarAnalise(
            `Resultado da pesquisa web sobre "${query}":\n\n${resultadoBruto}\n\nContexto: ${contexto || 'pesquisa solicitada pelo Maurício'}`,
            `Analise os resultados e extraia o que é mais relevante para a loja Ziont (camisetas personalizadas, Shopee Brasil). Seja objetivo — máximo 6 linhas.`
        )

        const entrada = `Pesquisa "${query}" em ${new Date().toLocaleDateString('pt-BR')}: ${resposta}`
        memoria.aprendizados.push(entrada)
        if (memoria.aprendizados.length > 50) memoria.aprendizados = memoria.aprendizados.slice(-50)
        memoria.ultima_atualizacao = new Date().toISOString()
        salvarJSON(MEMORIA_FILE, memoria)

        console.log(`🧠 [Zeon] Resultado da pesquisa salvo na memória`)
        return resposta
    } catch (err) {
        console.error('❌ [Zeon] Erro na pesquisa web:', err.message)
        return null
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// IA — Geração de estratégias e análises via Groq
// ─────────────────────────────────────────────────────────────────────────────

const ZEON_SYSTEM_PROMPT = `Você é Zeon, o Gestor Operacional (CEO) da loja Ziont, especializada em camisetas personalizadas vendidas na Shopee.

Sua missão principal: garantir que a meta diária de R$ 700,00 seja batida todos os dias.

Sua personalidade: direto, estratégico, proativo. Você não fica esperando — você age, analisa e cobra resultados.

Você coordena os seguintes agentes (ainda em construção, comunique-se com os disponíveis):
- Zaya: canal de comunicação (WhatsApp)
- Zyon: atendimento ao cliente na Shopee + pós-venda
- Fin: financeiro (porta 3002)
- Zop: operações e logística (futuro)
- Zad: marketing (futuro)
- Zan: analista de mercado (futuro)
- Zbuy: compras (futuro)

Regras fundamentais:
1. Qualquer gasto ou promoção: consultar Fin primeiro, depois pedir autorização ao Maurício
2. Decisões fora do padrão: sempre consultar Maurício via Zaya
3. Guardar aprendizados na memória para evoluir continuamente
4. Meta diária: R$ 700,00 — cobrar a equipe todos os dias
5. Você se identifica sempre como *Zeon* nas mensagens para o Maurício

Capacidades disponíveis (use proativamente):
- Fin: consultar limites e dados financeiros
- Zyon: consultar faturamento do dia/mês e pedidos a enviar em tempo real
- Pesquisa web: buscar tendências, concorrentes, estratégias, preços de mercado — quando Maurício pedir "pesquisa X", execute e salve na memória

Formato das mensagens para o Maurício:
- Sempre começar com *Zeon:*
- Ser direto e objetivo
- Quando precisar de autorização, deixar claro o que está pedindo e por quê`

async function gerarAnalise(contexto, tarefa) {
    const hoje = new Date().toLocaleDateString('pt-BR')
    const hora = new Date().toLocaleTimeString('pt-BR')

    const memoriaResumo = `
MEMÓRIA ATUAL:
- Estratégias que funcionaram: ${memoria.estrategias.slice(-5).map(e => e.descricao).join(', ') || 'nenhuma registrada ainda'}
- Últimas metas: ${memoria.historico_metas.slice(-7).map(m => `${m.data}: R$${m.faturamento} (${m.bateu ? '✅' : '❌'})`).join(', ') || 'sem histórico'}
- Estratégias do Maurício: ${memoria.estrategias_mauricio.slice(-3).join(', ') || 'nenhuma ainda'}
- Aprendizados: ${memoria.aprendizados.slice(-3).join(', ') || 'nenhum ainda'}
`

    const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 800,
        messages: [
            { role: 'system', content: ZEON_SYSTEM_PROMPT + '\n\n' + memoriaResumo },
            { role: 'user', content: `Data: ${hoje} | Hora: ${hora}\n\nContexto: ${contexto}\n\nTarefa: ${tarefa}\n\nResponda de forma objetiva e prática.` }
        ]
    })

    return response.choices[0].message.content.trim()
}

// ─────────────────────────────────────────────────────────────────────────────
// Relatório Matinal (7h)
// ─────────────────────────────────────────────────────────────────────────────

async function relatorioMatinal() {
    console.log(`\n🌅 [Zeon] Gerando relatório matinal — ${new Date().toLocaleTimeString('pt-BR')}`)

    try {
        // Busca dados do Fin e Zyon em paralelo
        const [limites, dadosZyon] = await Promise.all([
            consultarFin('/limites'),
            consultarZyon('/dados')
        ])
        const contextoFin = limites ? `Limites financeiros: ${JSON.stringify(limites.limites)}` : 'Fin não disponível'
        const contextoZyon = dadosZyon?.fatDia != null
            ? `Shopee (último ciclo): Dia R$${dadosZyon.fatDia}, Mês R$${dadosZyon.fatMes}, A enviar: ${dadosZyon.aEnviar} pedido(s)`
            : 'Dados Shopee não disponíveis (Zyon offline ou ainda sem coleta)'

        // Histórico recente
        const ultimasMetas = memoria.historico_metas.slice(-7)
        const mediaFaturamento = ultimasMetas.length > 0
            ? (ultimasMetas.reduce((s, m) => s + (m.faturamento || 0), 0) / ultimasMetas.length).toFixed(2)
            : 'sem dados'

        const contexto = `
Meta diária: R$ 700,00
Média dos últimos 7 dias: R$ ${mediaFaturamento}
${contextoFin}
${contextoZyon}
Dia da semana: ${new Date().toLocaleDateString('pt-BR', { weekday: 'long' })}
        `.trim()

        const tarefa = `Gere o relatório matinal da Ziont com:
1. Análise do desempenho recente (últimos dias)
2. Estratégias concretas para bater a meta hoje (R$ 700,00)
3. Pontos de atenção para o dia
4. Uma pergunta ou informação que precisa do Maurício para otimizar as estratégias de hoje
Seja direto e prático — máximo 15 linhas.`

        const analise = await gerarAnalise(contexto, tarefa)

        const hoje = new Date().toLocaleDateString('pt-BR')
        const msg = `*Zeon:* 🌅 *Bom dia, Maurício!*\n\n📅 ${hoje}\n\n${analise}\n\n💡 _Qualquer orientação é bem-vinda — estou monitorando o dia._`

        notificarZaya(msg)
        console.log(`📨 [Zeon] Relatório matinal enviado`)

        // Registra na memória
        memoria.ultima_atualizacao = new Date().toISOString()
        salvarJSON(MEMORIA_FILE, memoria)

    } catch (err) {
        console.error('❌ [Zeon] Erro no relatório matinal:', err.message)
        notificarZaya(`*Zeon:* ⚠️ Erro ao gerar relatório matinal: ${err.message}`)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Relatório Final (22h)
// ─────────────────────────────────────────────────────────────────────────────

async function relatorioFinal() {
    console.log(`\n🌙 [Zeon] Gerando relatório final — ${new Date().toLocaleTimeString('pt-BR')}`)

    try {
        const hoje = new Date().toLocaleDateString('pt-BR')

        const contexto = `
Meta diária: R$ 700,00
Dia: ${hoje}
Histórico recente: ${memoria.historico_metas.slice(-7).map(m => `${m.data}: R$${m.faturamento}`).join(', ') || 'sem dados'}
        `.trim()

        const tarefa = `Gere o relatório final do dia da Ziont.
Inclua:
1. Avaliação geral do dia (mesmo sem dados exatos de faturamento — baseie-se no que foi registrado)
2. O que funcionou hoje
3. O que pode melhorar amanhã
4. Estratégia inicial para amanhã
Seja direto — máximo 12 linhas.`

        const analise = await gerarAnalise(contexto, tarefa)

        const msg = `*Zeon:* 🌙 *Relatório Final — ${hoje}*\n\n${analise}\n\n_Até amanhã às 7h com o plano do dia!_`

        notificarZaya(msg)
        console.log(`📨 [Zeon] Relatório final enviado`)

    } catch (err) {
        console.error('❌ [Zeon] Erro no relatório final:', err.message)
        notificarZaya(`*Zeon:* ⚠️ Erro ao gerar relatório final: ${err.message}`)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Processar resposta do Maurício (autorização)
// ─────────────────────────────────────────────────────────────────────────────

async function processarRespostaMauricio(idDecisao, resposta) {
    const pendente = pendentes[idDecisao]
    if (!pendente) {
        console.log(`⚠️ [Zeon] Decisão pendente não encontrada: ${idDecisao}`)
        return
    }

    const autorizado = /sim|autorizo|pode|ok|vai|confirmo|yes/i.test(resposta)
    const negado = /nao|não|nega|cancela|para|stop|no/i.test(resposta)

    if (!autorizado && !negado) {
        notificarZaya(`*Zeon:* Maurício, não entendi sua resposta sobre "${pendente.descricao}". Por favor responda *sim* ou *não*.`)
        return
    }

    // Registra a decisão na memória
    const registro = {
        id: idDecisao,
        descricao: pendente.descricao,
        proposta: pendente.proposta,
        resposta: autorizado ? 'autorizado' : 'negado',
        data: new Date().toISOString()
    }
    decisoes.push(registro)
    if (decisoes.length > 200) decisoes = decisoes.slice(-200)
    salvarJSON(DECISOES_FILE, decisoes)

    // Aprende com a decisão
    if (autorizado) {
        memoria.aprendizados.push(`Maurício autorizou: ${pendente.descricao} em ${new Date().toLocaleDateString('pt-BR')}`)
    } else {
        memoria.aprendizados.push(`Maurício negou: ${pendente.descricao} em ${new Date().toLocaleDateString('pt-BR')}`)
    }
    if (memoria.aprendizados.length > 50) memoria.aprendizados = memoria.aprendizados.slice(-50)
    salvarJSON(MEMORIA_FILE, memoria)

    // Remove da fila de pendentes
    delete pendentes[idDecisao]
    salvarJSON(PENDENTES_FILE, pendentes)

    const statusMsg = autorizado ? '✅ Autorizado! Vou executar.' : '❌ Entendido, cancelado.'
    notificarZaya(`*Zeon:* ${statusMsg} (${pendente.descricao})`)

    console.log(`${autorizado ? '✅' : '❌'} [Zeon] Decisão processada: ${pendente.descricao} — ${autorizado ? 'autorizado' : 'negado'}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Solicitar autorização ao Maurício
// ─────────────────────────────────────────────────────────────────────────────

function solicitarAutorizacao(descricao, proposta, detalhes) {
    const id = `dec_${Date.now()}`
    pendentes[id] = { descricao, proposta, detalhes, criadoEm: new Date().toISOString() }
    salvarJSON(PENDENTES_FILE, pendentes)

    const msg = `*Zeon:* 📋 *Preciso da sua autorização*\n\n*Assunto:* ${descricao}\n\n*Proposta:* ${proposta}\n\n*Detalhes:* ${detalhes}\n\n_Responda *sim* para autorizar ou *não* para cancelar. ID: ${id}_`
    notificarZaya(msg)

    console.log(`📋 [Zeon] Autorização solicitada: ${descricao} (ID: ${id})`)
    return id
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar estratégia do Maurício na memória
// ─────────────────────────────────────────────────────────────────────────────

function registrarEstrategia(estrategia) {
    memoria.estrategias_mauricio.push(`${new Date().toLocaleDateString('pt-BR')}: ${estrategia}`)
    if (memoria.estrategias_mauricio.length > 30) memoria.estrategias_mauricio = memoria.estrategias_mauricio.slice(-30)
    memoria.ultima_atualizacao = new Date().toISOString()
    salvarJSON(MEMORIA_FILE, memoria)
    console.log(`🧠 [Zeon] Estratégia do Maurício registrada: ${estrategia}`)
    notificarZaya(`*Zeon:* ✅ Estratégia registrada na memória: "${estrategia}"`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Processar mensagem direta do Maurício
// ─────────────────────────────────────────────────────────────────────────────

const PALAVRAS_MEMORIA = ['estuda', 'guarda', 'anota', 'lembra', 'estratégia', 'estrategia']
const PALAVRAS_PESQUISA = ['pesquisa', 'pesquisar', 'busca', 'buscar', 'procura', 'procurar', 'pesquise', 'busque']
const PALAVRAS_SHOPEE = ['pedido', 'shopee', 'ads', 'anúncio', 'anuncio', 'impulsionar', 'boost', 'renda', 'carteira', 'saldo', 'métricas', 'metricas', 'a enviar', 'despacho', 'dispatch', 'faturamento', 'enviar hoje', 'enviar amanhã']

function chamarTarefaZyon(descricao) {
    return new Promise((resolve) => {
        const zyonUrl = process.env.ZYON_URL || 'http://localhost:3001'
        const data = JSON.stringify({ descricao })
        let parsedUrl
        try { parsedUrl = new URL(`${zyonUrl}/executar-tarefa`) } catch {
            return resolve(null)
        }
        const lib = parsedUrl.protocol === 'https:' ? https : http
        const port = parsedUrl.port ? Number(parsedUrl.port) : 80
        const req = lib.request({
            hostname: parsedUrl.hostname, port, path: parsedUrl.pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, res => {
            let corpo = ''
            res.on('data', chunk => { corpo += chunk })
            res.on('end', () => { try { resolve(JSON.parse(corpo)) } catch { resolve(null) } })
        })
        req.setTimeout(120000, () => { req.destroy(); resolve(null) })
        req.on('error', () => resolve(null))
        req.write(data)
        req.end()
    })
}

function formatarResultadoZyon(acao, resultado) {
    if (!resultado) return '⚠️ Zyon não respondeu ou ocorreu um erro.'
    if (resultado.naoIdentificado) return `Não consegui identificar uma ação Shopee específica para: "${resultado.descricao}"`
    switch (acao) {
        case 'pedidos_aenviar': {
            const r = resultado
            const linhas = [`📦 *Pedidos A Enviar — ${r.total ?? '?'} total*`]
            if (r.hoje?.length) linhas.push(`\n⚠️ *HOJE (${r.hoje.length}):*`, ...r.hoje.map(p => `• #${p.orderId} — ${p.produtoNome || '?'}`))
            if (r.amanha?.length) linhas.push(`\n📅 *AMANHÃ (${r.amanha.length}):*`, ...r.amanha.map(p => `• #${p.orderId} — ${p.produtoNome || '?'}`))
            if (!r.hoje?.length && !r.amanha?.length) linhas.push('Nenhum pedido urgente.')
            return linhas.join('\n')
        }
        case 'boost_anuncios':
            return `🚀 Boost executado — ${resultado.clicados ?? 0} botão(ões) clicado(s). Em destaque: ${resultado.emDestaque ?? '?'}`
        case 'verificar_ads': {
            const s = resultado.saldo != null ? `R$ ${resultado.saldo.toFixed(2)}` : '?'
            const g = resultado.gastoDia != null ? `R$ ${resultado.gastoDia.toFixed(2)}` : '?'
            return `💳 *Shopee Ads*\nSaldo: ${s}\nGasto hoje: ${g}${resultado.saldoBaixo ? '\n⚠️ *Saldo baixo!*' : ''}`
        }
        case 'renda':
            return `💰 *Minha Renda*\nPendente: ${resultado.rendaPendente != null ? `R$ ${resultado.rendaPendente.toFixed(2)}` : '?'}\nSemana: ${resultado.rendaSemana != null ? `R$ ${resultado.rendaSemana.toFixed(2)}` : '?'}\nMês: ${resultado.rendaMes != null ? `R$ ${resultado.rendaMes.toFixed(2)}` : '?'}`
        case 'carteira':
            return `💳 *Carteira ShopeePay*\nSaldo: ${resultado.saldo != null ? `R$ ${resultado.saldo.toFixed(2)}` : '?'}\nRetirada automática: ${resultado.retiradaAutomatica ? 'Ativa ✅' : 'Inativa/Desconhecida'}`
        case 'metricas':
            return `📊 *Métricas*\nFaturamento dia: ${resultado.fatDia ?? '?'}\nPedidos mês: ${resultado.totalPedidosMes ?? '?'}\nConversão: ${resultado.taxaConversao ?? '?'}%`
        case 'verificar_pedido_especifico':
            if (!resultado) return 'Pedido não encontrado.'
            return `🔍 *Pedido #${resultado.orderId}*\nStatus: ${resultado.status ?? '?'}${resultado.codigoRastreamento ? `\nRastreamento: ${resultado.codigoRastreamento}` : ''}`
        default:
            return `Resultado: ${JSON.stringify(resultado).substring(0, 300)}`
    }
}

async function processarMensagemMauricio(mensagem) {
    console.log(`💬 [Zeon] Mensagem do Maurício: ${mensagem}`)

    try {
        const mensagemLower = mensagem.toLowerCase()

        // Salva na memória quando pede explicitamente
        if (PALAVRAS_MEMORIA.some(p => mensagemLower.includes(p))) {
            registrarEstrategia(mensagem)
        }

        // Detecta pedidos relacionados à Shopee → delega ao Zyon via /executar-tarefa
        const ehShopee = PALAVRAS_SHOPEE.some(p => mensagemLower.includes(p))
        if (ehShopee) {
            console.log(`🛍️ [Zeon] Pedido Shopee identificado — delegando ao Zyon: ${mensagem}`)
            notificarZaya(`*Zeon:* 🛍️ Consultando o Zyon sobre: _${mensagem}_...`)
            const respZyon = await chamarTarefaZyon(mensagem)
            if (respZyon?.ok && respZyon.acao !== 'nao_identificado') {
                const texto = formatarResultadoZyon(respZyon.acao, respZyon.resultado)
                notificarZaya(`*Zeon:* ${texto}`)
            } else {
                // Não conseguiu mapear para ação específica — responde via Groq com contexto Shopee
                const dadosZyon = await consultarZyon('/dados')
                const contextoZyon = dadosZyon ? `Dados Shopee: Dia R$${dadosZyon.fatDia}, Mês R$${dadosZyon.fatMes}, A enviar: ${dadosZyon.aEnviar}.` : ''
                const resposta = await gerarAnalise(`Maurício perguntou sobre Shopee: "${mensagem}"\n${contextoZyon}`, 'Responda de forma direta. Máximo 6 linhas.')
                notificarZaya(`*Zeon:* ${resposta}`)
            }
            return
        }

        // Detecta intenção de pesquisa na web
        const devePesquisar = PALAVRAS_PESQUISA.some(p => mensagemLower.startsWith(p) || mensagemLower.includes(` ${p} `))
        if (devePesquisar) {
            const query = mensagem.replace(new RegExp(`^(${PALAVRAS_PESQUISA.join('|')})[^\\w]*`, 'i'), '').trim() || mensagem
            notificarZaya(`*Zeon:* 🔍 Pesquisando: _${query}_...`)
            const resultado = await pesquisarESalvar(query, mensagem)
            if (resultado) {
                notificarZaya(`*Zeon:* 🔍 *Resultado da pesquisa — ${query}:*\n\n${resultado}\n\n_Salvo na memória._`)
                return
            }
        }

        // Resposta geral via Groq
        const dadosZyon = await consultarZyon('/dados')
        const contextoZyon = dadosZyon?.fatDia != null
            ? `Shopee agora: Dia R$${dadosZyon.fatDia}, Mês R$${dadosZyon.fatMes}, A enviar: ${dadosZyon.aEnviar}.`
            : ''

        const resposta = await gerarAnalise(
            `Maurício enviou: "${mensagem}"${contextoZyon ? `\n\n${contextoZyon}` : ''}`,
            `Responda ao Maurício de forma direta e objetiva. Se for pergunta, responda. Se for instrução, confirme e execute. Máximo 8 linhas.`
        )

        notificarZaya(`*Zeon:* ${resposta}`)
        console.log(`📨 [Zeon] Resposta enviada ao Maurício`)
    } catch (err) {
        console.error('❌ [Zeon] Erro ao processar mensagem do Maurício:', err.message)
        notificarZaya(`*Zeon:* ⚠️ Erro ao processar sua mensagem: ${err.message}`)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar resultado do dia na memória
// ─────────────────────────────────────────────────────────────────────────────

function registrarResultadoDia(faturamento) {
    const hoje = new Date().toLocaleDateString('pt-BR')
    const bateu = faturamento >= 700

    memoria.historico_metas.push({
        data: hoje,
        faturamento,
        bateu,
        registradoEm: new Date().toISOString()
    })
    if (memoria.historico_metas.length > 90) memoria.historico_metas = memoria.historico_metas.slice(-90)

    if (bateu) {
        memoria.estrategias.push({
            descricao: `Meta batida em ${hoje}: R$${faturamento}`,
            data: hoje
        })
        if (memoria.estrategias.length > 50) memoria.estrategias = memoria.estrategias.slice(-50)
    }

    salvarJSON(MEMORIA_FILE, memoria)
    console.log(`📊 [Zeon] Resultado registrado: ${hoje} — R$${faturamento} (${bateu ? 'META BATIDA ✅' : 'meta não batida ❌'})`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Monitoramento contínuo (a cada 2h durante o dia)
// ─────────────────────────────────────────────────────────────────────────────

async function monitoramentoIntermediario() {
    const hora = new Date().getHours()
    // Só monitora entre 8h e 21h
    if (hora < 8 || hora > 21) return

    console.log(`\n🔍 [Zeon] Monitoramento intermediário — ${new Date().toLocaleTimeString('pt-BR')}`)

    try {
        const dadosZyon = await consultarZyon('/dados')
        const progressoVendas = dadosZyon?.fatDia != null
            ? `Faturamento atual do dia: R$${dadosZyon.fatDia} de R$700,00 meta. Pedidos a enviar: ${dadosZyon.aEnviar}.`
            : 'Dados de faturamento não disponíveis no momento.'
        const contexto = `Monitoramento de rotina. Meta: R$ 700,00. ${progressoVendas}`
        const tarefa = `Faça uma análise rápida (máximo 5 linhas) verificando:
1. Se há algo urgente a fazer agora para garantir a meta
2. Se precisa acionar algum agente ou pedir algo ao Maurício
Se não houver nada urgente, responda apenas: "Tudo sob controle. Monitorando."`

        const analise = await gerarAnalise(contexto, tarefa)

        // Só notifica Maurício se houver algo importante (evita spam)
        if (!/tudo sob controle/i.test(analise)) {
            notificarZaya(`*Zeon:* 🔍 ${analise}`)
        } else {
            console.log(`🔍 [Zeon] Sem alertas — ${analise}`)
        }
    } catch (err) {
        console.error('❌ [Zeon] Erro no monitoramento intermediário:', err.message)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Agendamentos (cron)
// ─────────────────────────────────────────────────────────────────────────────

// Relatório matinal: 7h
cron.schedule('0 7 * * *', () => {
    relatorioMatinal()
}, { timezone: 'America/Sao_Paulo' })

// Relatório final: 22h
cron.schedule('0 22 * * *', () => {
    relatorioFinal()
}, { timezone: 'America/Sao_Paulo' })

// Monitoramento intermediário: a cada 2h (8h, 10h, 12h, 14h, 16h, 18h, 20h)
cron.schedule('0 8,10,12,14,16,18,20 * * *', () => {
    monitoramentoIntermediario()
}, { timezone: 'America/Sao_Paulo' })

// ─────────────────────────────────────────────────────────────────────────────
// Servidor HTTP
// ─────────────────────────────────────────────────────────────────────────────

const ZEON_PORT = Number(process.env.ZEON_PORT) || 3003

const zeonServer = http.createServer((req, res) => {

    // Zaya repassa mensagem direta do Maurício para o Zeon processar
    if (req.method === 'POST' && req.url === '/mensagem-mauricio') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
            try {
                const { mensagem } = JSON.parse(body)
                if (!mensagem) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    return res.end(JSON.stringify({ ok: false, error: 'Informe a mensagem' }))
                }
                processarMensagemMauricio(mensagem)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true }))
            } catch (err) {
                console.error('❌ /mensagem-mauricio error:', err.message)
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: err.message }))
            }
        })

    // Zaya repassa resposta do Maurício (autorização de decisão)
    } else if (req.method === 'POST' && req.url === '/resposta-mauricio') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
            try {
                const { idDecisao, resposta } = JSON.parse(body)
                if (!idDecisao || !resposta) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    return res.end(JSON.stringify({ ok: false, error: 'Informe idDecisao e resposta' }))
                }
                await processarRespostaMauricio(idDecisao, resposta)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true }))
            } catch (err) {
                console.error('❌ /resposta-mauricio error:', err.message)
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: err.message }))
            }
        })

    // Maurício passa uma estratégia para o Zeon guardar
    } else if (req.method === 'POST' && req.url === '/estrategia') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
            try {
                const { estrategia } = JSON.parse(body)
                if (!estrategia) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    return res.end(JSON.stringify({ ok: false, error: 'Informe a estrategia' }))
                }
                registrarEstrategia(estrategia)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true }))
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: err.message }))
            }
        })

    // Registrar resultado do dia (pode ser chamado pelo Fin ou manualmente)
    } else if (req.method === 'POST' && req.url === '/resultado-dia') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
            try {
                const { faturamento } = JSON.parse(body)
                if (typeof faturamento !== 'number') {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    return res.end(JSON.stringify({ ok: false, error: 'Informe o faturamento (número)' }))
                }
                registrarResultadoDia(faturamento)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true }))
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: err.message }))
            }
        })

    // Solicitar autorização ao Maurício
    } else if (req.method === 'POST' && req.url === '/solicitar-autorizacao') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
            try {
                const { descricao, proposta, detalhes } = JSON.parse(body)
                const id = solicitarAutorizacao(descricao, proposta, detalhes || '')
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true, idDecisao: id }))
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: err.message }))
            }
        })

    // Pesquisa na web e salva na memória
    } else if (req.method === 'POST' && req.url === '/pesquisar') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
            try {
                const { query } = JSON.parse(body)
                if (!query) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    return res.end(JSON.stringify({ ok: false, error: 'Informe o query' }))
                }
                const resultado = await pesquisarESalvar(query, 'pesquisa manual via API')
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true, resultado }))
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: err.message }))
            }
        })

    // Consulta a memória do Zeon
    } else if (req.method === 'GET' && req.url === '/memoria') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, memoria }))

    // Consulta decisões pendentes
    } else if (req.method === 'GET' && req.url === '/pendentes') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, pendentes }))

    // Health check
    } else if (req.url === '/health') {
        res.writeHead(200)
        res.end('ok')

    } else {
        res.writeHead(404)
        res.end()
    }
})

zeonServer.listen(ZEON_PORT, () => {
    console.log(`🚀 Zeon HTTP server escutando na porta ${ZEON_PORT}`)
})

console.log('⚡ Zeon iniciado — Gestor Operacional da Ziont')
console.log('📅 Relatório matinal agendado para 7h (Brasília)')
console.log('🌙 Relatório final agendado para 22h (Brasília)')
console.log('🔍 Monitoramento intermediário: 8h, 10h, 12h, 14h, 16h, 18h, 20h')
console.log(`📡 Zaya URL: ${process.env.ZAYA_URL || '(não configurada — defina ZAYA_URL no .env)'}`)
console.log(`💰 Fin URL: ${process.env.FIN_URL || 'http://localhost:3002 (padrão)'}`)
console.log(`🛍️  Zyon URL: ${process.env.ZYON_URL || 'http://localhost:3001 (padrão)'}`)
console.log('🌐 Pesquisa web: DuckDuckGo API (sem chave — automática)')
console.log('─────────────────────────────────────────────────────────────────')
