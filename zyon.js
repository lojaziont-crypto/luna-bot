require('dotenv').config()

process.on('uncaughtException', (err) => {
    console.error('[ERRO FATAL]', err.message)
})
process.on('unhandledRejection', (err) => {
    console.error('[PROMISE REJEITADA]', err?.message || err)
})

const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const Groq = require('groq-sdk')
const {
    verificarNovosPedidos, coletarFaturamentoGerencial, coletarStatusPedidos,
    coletarPedidosAEnviar, impulsionarAnuncios, verificarSaldoAds,
    coletarRenda, coletarSaldoCarteira, coletarMetricasCompletas,
    launchBrowser, resolverChrome, configurarPagina,
    listarPedidosEmAberto, verificarStatusPedidos,
} = require('./shopee-agent')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const PEDIDOS_FILE = path.join(__dirname, 'pedidos_vistos.json')
const BOOST_LOG_FILE = path.join(__dirname, 'zyon_boost_log.json')
let ultimoPedidoVisto = null
let emColeta = false  // mutex: nunca abre dois browsers ao mesmo tempo

const ultimaExecucao = {
    pedidos: Date.now(),
    dados: Date.now(),
    boost: Date.now(),
    ads: Date.now(),
    gerencial: Date.now(),
}

async function executarComSeguranca(nome, tarefa) {
    try {
        await tarefa()
    } catch (err) {
        console.error(`❌ [Zyon] Erro não tratado em ${nome}:`, err?.message || err)
    }
}

try {
    if (fs.existsSync(PEDIDOS_FILE)) {
        ultimoPedidoVisto = JSON.parse(fs.readFileSync(PEDIDOS_FILE, 'utf8')).ultimoId || null
    }
} catch {}

function salvarUltimoPedido(id) {
    fs.writeFileSync(PEDIDOS_FILE, JSON.stringify({ ultimoId: id }))
}

function carregarJSON(arquivo, padrao) {
    try {
        if (fs.existsSync(arquivo)) return JSON.parse(fs.readFileSync(arquivo, 'utf8'))
    } catch {}
    return padrao
}
function salvarJSON(arquivo, dados) {
    fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2))
}

let ultimosDados = { fatDia: null, fatMes: null, aEnviar: null, atualizadoEm: null }
let ultimosPedidosAEnviar = { hoje: [], amanha: [], outros: [], total: 0, atualizadoEm: null }
let ultimasMetricas = null

// ─────────────────────────── Comunicação com Zaya ────────────────────────────

function postZaya(endpoint, dados) {
    const url = process.env.ZAYA_URL
    if (!url) {
        console.log(`⚠️  [Zyon] ZAYA_URL não definida — ${endpoint} não enviado`)
        return
    }
    const data = JSON.stringify(dados)
    let parsedUrl
    try { parsedUrl = new URL(`${url}${endpoint}`) } catch {
        console.error(`❌ [Zyon] ZAYA_URL inválida: ${url}`)
        return
    }
    const lib = parsedUrl.protocol === 'https:' ? https : http
    const port = parsedUrl.port ? Number(parsedUrl.port) : (parsedUrl.protocol === 'https:' ? 443 : 80)
    const req = lib.request({
        hostname: parsedUrl.hostname, port,
        path: parsedUrl.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => { console.log(`📨 [Zyon] POST ${endpoint} → Zaya (HTTP ${res.statusCode})`) })
    req.on('error', err => console.error(`❌ [Zyon] Erro ao chamar ${endpoint}: ${err.message}`))
    req.write(data)
    req.end()
}

function notifyZaya(orderId) {
    postZaya('/notify-order', { orderId })
}

function enviarDadosParaZaya(fatDia, fatMes, aEnviar) {
    postZaya('/update-faturamento', { fatDia, fatMes, aEnviar })
    console.log(`💰 [Zyon] Dia: R$ ${fatDia || '?'} | Mês: R$ ${fatMes || '?'} | A Enviar: ${aEnviar || '?'}`)
}

function notifyZayaProducaoLucas(pedidosHoje, pedidosAmanha) {
    postZaya('/notify-producao-lucas', { pedidosHoje, pedidosAmanha })
}

// Envia mensagem de texto ao dono via canal /zeon-notificacao
function notifyDono(mensagem) {
    postZaya('/zeon-notificacao', { mensagem })
}

// ─────────────────────────── Rotinas de coleta ───────────────────────────────

async function checarNovosPedidos() {
    ultimaExecucao.pedidos = Date.now()
    if (emColeta) {
        console.log('⏭️  [Zyon] Browser ocupado — verificação de pedidos adiada')
        return
    }
    emColeta = true
    try {
        const hora = new Date().toLocaleTimeString('pt-BR')
        console.log(`\n🔍 [Zyon] Verificando pedidos... ${hora}`)

        const primeiroId = await verificarNovosPedidos()

        if (!primeiroId) {
            console.log('📦 [Zyon] Nenhum pedido encontrado na página')
            return
        }

        console.log(`🔢 [Zyon] Primeiro pedido da lista: ${primeiroId}`)

        if (!ultimoPedidoVisto) {
            ultimoPedidoVisto = primeiroId
            salvarUltimoPedido(primeiroId)
            console.log(`✅ [Zyon] Monitoramento inicializado — último pedido: ${primeiroId}`)
            return
        }

        if (primeiroId === ultimoPedidoVisto) {
            console.log('📦 [Zyon] Nenhum pedido novo')
            return
        }

        console.log(`🛍️  [Zyon] NOVO PEDIDO DETECTADO: #${primeiroId}`)
        notifyZaya(primeiroId)
        ultimoPedidoVisto = primeiroId
        salvarUltimoPedido(primeiroId)
    } catch (err) {
        console.error('❌ [Zyon] Erro ao verificar pedidos:', err.message)
    } finally {
        emColeta = false
    }
}

async function coletarEEnviarDados() {
    ultimaExecucao.dados = Date.now()
    if (emColeta) {
        console.log('⏭️  [Zyon] Browser ocupado — coleta de faturamento adiada')
        return
    }
    emColeta = true
    try {
        console.log(`\n📊 [Zyon] Coletando dados Shopee — ${new Date().toLocaleTimeString('pt-BR')}`)
        const { fatDia, fatMes } = await coletarFaturamentoGerencial()
        const { orderText } = await coletarStatusPedidos()
        const m = orderText.match(/A Enviar\s*\((\d+)\)/i)
        const aEnviar = m ? m[1] : null
        ultimosDados = { fatDia, fatMes, aEnviar, atualizadoEm: new Date().toISOString() }
        enviarDadosParaZaya(fatDia, fatMes, aEnviar)
    } catch (err) {
        console.error('❌ [Zyon] Erro ao coletar dados Shopee:', err.message)
    } finally {
        emColeta = false
    }
}

// ────────── Pedidos A Enviar — coleta intermediária e aviso ~17h ──────────────

async function atualizarPedidosAEnviar() {
    if (emColeta) {
        console.log('⏭️  [Zyon] Browser ocupado — atualização de pedidos adiada')
        return
    }
    emColeta = true
    try {
        console.log(`\n📦 [Zyon] Atualizando lista de pedidos A Enviar — ${new Date().toLocaleTimeString('pt-BR')}`)
        const resultado = await coletarPedidosAEnviar()
        ultimosPedidosAEnviar = { ...resultado, atualizadoEm: new Date().toISOString() }
        console.log(`📦 [Zyon] Atualizado — HOJE: ${resultado.hoje.length}, AMANHÃ: ${resultado.amanha.length}, Outros: ${resultado.outros.length}`)
    } catch (err) {
        console.error('❌ [Zyon] Erro ao atualizar pedidos A Enviar:', err.message)
    } finally {
        emColeta = false
    }
}

async function avisarLucasProducao() {
    if (emColeta) {
        console.log('⏭️  [Zyon] Browser ocupado — aviso de produção ao Lucas adiado')
        return
    }
    emColeta = true
    try {
        console.log(`\n🎨 [Zyon] Coletando pedidos para aviso ao Lucas — ${new Date().toLocaleTimeString('pt-BR')}`)
        const resultado = await coletarPedidosAEnviar()
        ultimosPedidosAEnviar = { ...resultado, atualizadoEm: new Date().toISOString() }

        const total = resultado.hoje.length + resultado.amanha.length
        if (total === 0) {
            console.log('🎨 [Zyon] Nenhum pedido urgente — aviso ao Lucas não necessário')
            return
        }
        console.log(`🎨 [Zyon] HOJE: ${resultado.hoje.length} | AMANHÃ: ${resultado.amanha.length} — notificando Lucas`)
        notifyZayaProducaoLucas(resultado.hoje, resultado.amanha)
    } catch (err) {
        console.error('❌ [Zyon] Erro ao coletar pedidos para aviso ao Lucas:', err.message)
    } finally {
        emColeta = false
    }
}

// ─────────────────── Boost de anúncios (~4h com variação ±20min) ─────────────

async function executarBoost() {
    ultimaExecucao.boost = Date.now()
    if (emColeta) {
        console.log('⏭️  [Zyon] Browser ocupado — boost adiado')
        return
    }
    emColeta = true
    try {
        console.log(`\n🚀 [Zyon] Impulsionando anúncios — ${new Date().toLocaleTimeString('pt-BR')}`)
        const resultado = await impulsionarAnuncios()

        // Registra log de boost
        const log = carregarJSON(BOOST_LOG_FILE, [])
        log.push(resultado)
        if (log.length > 100) log.splice(0, log.length - 100)
        salvarJSON(BOOST_LOG_FILE, log)

        if (resultado.clicados > 0) {
            console.log(`🚀 [Zyon/boost] ${resultado.clicados} produto(s) impulsionados`)
        }
    } catch (err) {
        console.error('❌ [Zyon] Erro ao impulsionar anúncios:', err.message)
    } finally {
        emColeta = false
    }
}

// ────────────────── Verificação de Ads + Financeiro (2-3x/dia) ───────────────

async function verificarAdsEFinanceiro() {
    ultimaExecucao.ads = Date.now()
    if (emColeta) {
        console.log('⏭️  [Zyon] Browser ocupado — verificação de ads adiada')
        return
    }
    emColeta = true
    try {
        console.log(`\n💳 [Zyon] Verificando Ads + Financeiro — ${new Date().toLocaleTimeString('pt-BR')}`)

        // Saldo Ads
        const ads = await verificarSaldoAds()
        if (ads.saldoBaixo) {
            const msg = `⚠️ *[Zyon] Saldo de Shopee Ads baixo!*\n\nSaldo atual: R$ ${ads.saldo?.toFixed(2) ?? '?'}\nGasto hoje: R$ ${ads.gastoDia?.toFixed(2) ?? '?'}\n\n_Recarregue manualmente para não pausar os anúncios._`
            notifyDono(msg)
            console.log(`⚠️ [Zyon/ads] Saldo baixo (R$ ${ads.saldo?.toFixed(2)}) — dono notificado`)
        }

        // Renda + Carteira
        const renda = await coletarRenda()
        const carteira = await coletarSaldoCarteira()

        console.log(`💰 [Zyon] Renda pendente: R$ ${renda.rendaPendente ?? '?'} | Carteira: R$ ${carteira.saldo ?? '?'}`)

        return { ads, renda, carteira }
    } catch (err) {
        console.error('❌ [Zyon] Erro ao verificar ads/financeiro:', err.message)
        return null
    } finally {
        emColeta = false
    }
}

// ────────────── Informações Gerenciais + Resumo IA (~20h-21h) ─────────────────

async function coletarRelatorioGerencial() {
    ultimaExecucao.gerencial = Date.now()
    if (emColeta) {
        console.log('⏭️  [Zyon] Browser ocupado — relatório gerencial adiado')
        return
    }
    emColeta = true
    try {
        console.log(`\n📊 [Zyon] Coletando métricas gerenciais — ${new Date().toLocaleTimeString('pt-BR')}`)
        const metricas = await coletarMetricasCompletas()
        ultimasMetricas = metricas

        // Gera resumo via Groq
        const resumo = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            max_tokens: 400,
            messages: [{
                role: 'user',
                content: `Você é um assistente de loja Shopee. Analise estes dados e gere um resumo executivo em PT-BR em no máximo 8 linhas: situação geral, top produtos se disponível, alertas importantes.

Dados:
- Faturamento do dia: R$ ${metricas.fatDia ?? '?'}
- Pedidos do mês: ${metricas.totalPedidosMes ?? '?'}
- Taxa de conversão: ${metricas.taxaConversao ?? '?'}%
- Pedidos A Enviar HOJE: ${ultimosPedidosAEnviar.hoje.length}
- Pedidos A Enviar AMANHÃ: ${ultimosPedidosAEnviar.amanha.length}
- Texto da página: ${(metricas.resumoTexto || '').substring(0, 800)}

Seja direto. Comece com "📊 Situação:"`,
            }],
        }).then(r => r.choices[0].message.content.trim()).catch(() => null)

        if (resumo) {
            console.log(`📊 [Zyon] Resumo gerencial gerado`)
            return { metricas, resumo }
        }
        return { metricas, resumo: null }
    } catch (err) {
        console.error('❌ [Zyon] Erro ao coletar relatório gerencial:', err.message)
        return null
    } finally {
        emColeta = false
    }
}

// ─────────────────────── Relatório Consolidado (PARTE C) ─────────────────────

async function enviarRelatorioConsolidado() {
    console.log(`\n🌙 [Zyon] Gerando relatório consolidado — ${new Date().toLocaleTimeString('pt-BR')}`)
    try {
        const hoje = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })

        const linhas = [
            `📋 *Resumo Zyon — ${hoje}*`,
            ``,
            `🛍️ Pedidos A Enviar: ${ultimosPedidosAEnviar.total} total (${ultimosPedidosAEnviar.hoje.length} urgentes hoje, ${ultimosPedidosAEnviar.amanha.length} amanhã)`,
        ]

        if (ultimosDados.fatDia) linhas.push(`💰 Faturamento do dia: R$ ${ultimosDados.fatDia}`)
        if (ultimosDados.fatMes) linhas.push(`📈 Faturamento do mês: R$ ${ultimosDados.fatMes}`)

        if (ultimasMetricas) {
            if (ultimasMetricas.totalPedidosMes) linhas.push(`📦 Pedidos no mês: ${ultimasMetricas.totalPedidosMes}`)
            if (ultimasMetricas.taxaConversao) linhas.push(`🎯 Conversão: ${ultimasMetricas.taxaConversao}%`)
        }

        // Inclui resumo gerencial se disponível
        if (ultimasMetricas?.resumo) {
            linhas.push(``, ultimasMetricas.resumo)
        }

        linhas.push(``, `_Próxima atualização: amanhã cedo._`)

        const mensagem = linhas.join('\n')
        notifyDono(mensagem)
        console.log(`📨 [Zyon] Relatório consolidado enviado ao dono`)
    } catch (err) {
        console.error('❌ [Zyon] Erro ao enviar relatório consolidado:', err.message)
    }
}

// ─────────────────────────── Endpoints HTTP ──────────────────────────────────

const ZYON_PORT = Number(process.env.ZYON_PORT) || 3001

const zyonServer = http.createServer(async (req, res) => {

    if (req.method === 'GET' && req.url === '/dados') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ...ultimosDados, pedidosAEnviar: ultimosPedidosAEnviar }))

    } else if (req.method === 'POST' && req.url === '/solicitar-faturamento') {
        console.log(`\n📥 [Zyon] Coleta imediata solicitada — ${new Date().toLocaleTimeString('pt-BR')}`)
        await coletarEEnviarDados()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))

    } else if (req.method === 'POST' && req.url === '/verificar-pedidos-enviados') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
            try {
                const { orderIds, listaId } = JSON.parse(body)
                if (!Array.isArray(orderIds) || orderIds.length === 0) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: 'orderIds inválido' }))
                    return
                }
                console.log(`\n🔍 [Zyon] Verificando despacho de ${orderIds.length} pedido(s) (lista ${listaId || '?'})`)

                if (emColeta) {
                    res.writeHead(503, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: 'browser ocupado, tente novamente em alguns minutos' }))
                    return
                }

                emColeta = true
                let resultados = []
                try {
                    const browser = await launchBrowser(resolverChrome())
                    try {
                        const page = await browser.newPage()
                        await configurarPagina(page)
                        resultados = await verificarStatusPedidos(page, orderIds)
                    } finally {
                        if (browser.isConnected()) await browser.close().catch(() => {})
                    }
                } finally {
                    emColeta = false
                }

                const enviados = resultados.filter(r => r.enviado).map(r => r.orderId)
                const pendentes = resultados.filter(r => !r.enviado).map(r => r.orderId)
                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true, resultados, enviados, pendentes }))
            } catch (err) {
                emColeta = false
                console.error('❌ [Zyon] Erro em /verificar-pedidos-enviados:', err.message)
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: err.message }))
            }
        })

    // PARTE D — tarefas sob demanda via Zeon
    } else if (req.method === 'POST' && req.url === '/executar-tarefa') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
            try {
                const { descricao } = JSON.parse(body)
                if (!descricao) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: 'Informe a descricao da tarefa' }))
                    return
                }
                console.log(`\n⚡ [Zyon] Tarefa sob demanda recebida: ${descricao}`)

                // Interpreta a tarefa com Groq
                const interpretacao = await groq.chat.completions.create({
                    model: 'llama-3.3-70b-versatile',
                    max_tokens: 200,
                    response_format: { type: 'json_object' },
                    messages: [{
                        role: 'user',
                        content: `Você é um assistente que mapeia pedidos em texto para ações de um agente Shopee.

Pedido: "${descricao}"

Mapeie para UMA das ações: pedidos_aenviar, boost_anuncios, verificar_ads, renda, carteira, metricas, verificar_pedido_especifico, nao_identificado

Se for "verificar_pedido_especifico", extraia o orderId do texto.

Responda SOMENTE em JSON: {"acao": "...", "orderId": null ou "ID_AQUI", "justificativa": "..."}`
                    }],
                }).then(r => JSON.parse(r.choices[0].message.content)).catch(() => ({ acao: 'nao_identificado' }))

                console.log(`⚡ [Zyon] Ação identificada: ${interpretacao.acao}`)

                if (emColeta) {
                    res.writeHead(503, { 'Content-Type': 'application/json' })
                    res.end(JSON.stringify({ ok: false, error: 'browser ocupado, tente em alguns minutos', acao: interpretacao.acao }))
                    return
                }

                let resultado = null

                switch (interpretacao.acao) {
                    case 'pedidos_aenviar':
                        emColeta = true
                        try { resultado = await coletarPedidosAEnviar() } finally { emColeta = false }
                        break
                    case 'boost_anuncios':
                        emColeta = true
                        try { resultado = await impulsionarAnuncios() } finally { emColeta = false }
                        break
                    case 'verificar_ads':
                        emColeta = true
                        try { resultado = await verificarSaldoAds() } finally { emColeta = false }
                        break
                    case 'renda':
                        emColeta = true
                        try { resultado = await coletarRenda() } finally { emColeta = false }
                        break
                    case 'carteira':
                        emColeta = true
                        try { resultado = await coletarSaldoCarteira() } finally { emColeta = false }
                        break
                    case 'metricas':
                        emColeta = true
                        try { resultado = await coletarMetricasCompletas() } finally { emColeta = false }
                        break
                    case 'verificar_pedido_especifico':
                        if (interpretacao.orderId) {
                            emColeta = true
                            try {
                                const browser = await launchBrowser(resolverChrome())
                                try {
                                    const page = await browser.newPage()
                                    await configurarPagina(page)
                                    const r = await verificarStatusPedidos(page, [interpretacao.orderId])
                                    resultado = r[0] || null
                                } finally { if (browser.isConnected()) await browser.close().catch(() => {}) }
                            } finally { emColeta = false }
                        }
                        break
                    default:
                        resultado = { naoIdentificado: true, descricao }
                }

                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true, acao: interpretacao.acao, resultado }))
            } catch (err) {
                emColeta = false
                console.error('❌ [Zyon] Erro em /executar-tarefa:', err.message)
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: err.message }))
            }
        })

    } else {
        res.writeHead(404)
        res.end()
    }
})
zyonServer.listen(ZYON_PORT, () => {
    console.log(`🌐 Zyon HTTP server escutando na porta ${ZYON_PORT}`)
})

// ───────────────────── Agendamentos humanizados ───────────────────────────────

// Agenda próxima execução com variação aleatória (não-repetitiva como setInterval)
function agendarProxima(nome, fn, intervaloBaseMs, variacaoMs) {
    const delay = Math.max(60000, intervaloBaseMs + Math.floor((Math.random() * 2 - 1) * variacaoMs))
    setTimeout(async () => {
        await executarComSeguranca(nome, fn)
        agendarProxima(nome, fn, intervaloBaseMs, variacaoMs)
    }, delay)
}

// Agenda execução única num horário-alvo com variação em minutos
function agendarHorario(nome, fn, horaAlvo, minAlvo, variacaoMinutos, repetirDiariamente = true) {
    const agora = new Date()
    const alvo = new Date(agora)
    const varMs = Math.floor((Math.random() * 2 - 1) * variacaoMinutos * 60000)
    alvo.setHours(horaAlvo, minAlvo, 0, 0)
    alvo.setTime(alvo.getTime() + varMs)
    if (alvo <= agora) alvo.setDate(alvo.getDate() + 1)
    const msAte = alvo - agora
    console.log(`🕐 [Zyon] "${nome}" agendado para ${alvo.toLocaleTimeString('pt-BR')} (em ${Math.round(msAte / 60000)} min)`)
    setTimeout(async () => {
        await executarComSeguranca(nome, fn)
        if (repetirDiariamente) agendarHorario(nome, fn, horaAlvo, minAlvo, variacaoMinutos, true)
    }, msAte)
}

// Intervalo de pedidos: 30min base com ±5min de variação (25-35min efetivos)
const INTERVALO_PEDIDOS_BASE = 30 * 60 * 1000
const VARIACAO_PEDIDOS = 5 * 60 * 1000

// Intervalo de faturamento: 60min base
const INTERVALO_DADOS_BASE = 60 * 60 * 1000

// Boost: 4h base com ±20min
const INTERVALO_BOOST_BASE = 4 * 60 * 60 * 1000
const VARIACAO_BOOST = 20 * 60 * 1000

// Ads/financeiro: 3 vezes por dia em horários variáveis
const INTERVALO_ADS_BASE = 8 * 60 * 60 * 1000
const VARIACAO_ADS = 30 * 60 * 1000

// Watchdog: detecta se alguma tarefa ficou parada por muito tempo
const WATCHDOG_INTERVALO_MS = 5 * 60 * 1000
const WATCHDOG_TOLERANCIA = 2.5

function verificarEReiniciarIntervalos() {
    const agora = Date.now()
    if (agora - ultimaExecucao.pedidos > INTERVALO_PEDIDOS_BASE * WATCHDOG_TOLERANCIA) {
        console.warn('🐶 [Zyon/watchdog] Monitoramento de pedidos parado — reiniciando...')
        ultimaExecucao.pedidos = agora
        agendarProxima('checarNovosPedidos', checarNovosPedidos, INTERVALO_PEDIDOS_BASE, VARIACAO_PEDIDOS)
        executarComSeguranca('checarNovosPedidos', checarNovosPedidos)
    }
    if (agora - ultimaExecucao.boost > INTERVALO_BOOST_BASE * WATCHDOG_TOLERANCIA) {
        console.warn('🐶 [Zyon/watchdog] Boost parado — reagendando...')
        ultimaExecucao.boost = agora
        agendarProxima('executarBoost', executarBoost, INTERVALO_BOOST_BASE, VARIACAO_BOOST)
    }
}

// ─────────────────────── Sequência de inicialização ──────────────────────────

console.log('⚡ Zyon iniciado — agente operacional Shopee')
console.log(`📡 Zaya URL: ${process.env.ZAYA_URL || '(não configurada — defina ZAYA_URL no .env)'}`)
console.log('─────────────────────────────────────────────────')

;(async () => {
    // Startup: verifica pedidos e dados imediatamente (sequencial para não abrir dois browsers)
    await executarComSeguranca('checarNovosPedidos', checarNovosPedidos)
    await executarComSeguranca('coletarEEnviarDados', coletarEEnviarDados)
    await executarComSeguranca('atualizarPedidosAEnviar', atualizarPedidosAEnviar)
    await executarComSeguranca('executarBoost', executarBoost)
})()

// Agendamentos periódicos com variação humanizada
agendarProxima('checarNovosPedidos', checarNovosPedidos, INTERVALO_PEDIDOS_BASE, VARIACAO_PEDIDOS)
agendarProxima('coletarEEnviarDados', coletarEEnviarDados, INTERVALO_DADOS_BASE, 10 * 60 * 1000)
agendarProxima('executarBoost', executarBoost, INTERVALO_BOOST_BASE, VARIACAO_BOOST)
agendarProxima('verificarAdsEFinanceiro', verificarAdsEFinanceiro, INTERVALO_ADS_BASE, VARIACAO_ADS)
agendarProxima('atualizarPedidosAEnviar', atualizarPedidosAEnviar, INTERVALO_PEDIDOS_BASE, VARIACAO_PEDIDOS)

// Aviso ao Lucas ~17h (16h50-17h15) — diário
agendarHorario('avisarLucasProducao', avisarLucasProducao, 17, 0, 15)

// Métricas gerenciais ~20h30 (±30min) — diário
agendarHorario('coletarRelatorioGerencial', coletarRelatorioGerencial, 20, 30, 30)

// Relatório consolidado ~22h (±20min) — diário
agendarHorario('enviarRelatorioConsolidado', enviarRelatorioConsolidado, 22, 0, 20)

// Watchdog
setInterval(verificarEReiniciarIntervalos, WATCHDOG_INTERVALO_MS)
