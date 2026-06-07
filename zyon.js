require('dotenv').config()

const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const Groq = require('groq-sdk')
const {
    verificarNovosPedidos, coletarFaturamentoGerencial, coletarStatusPedidos,
    launchBrowser, resolverChrome,
    abrirChat, abrirProximaConversaNaoRespondida, lerConversaCompleta, enviarMensagemNoChat, extrairInfoProduto,
} = require('./shopee-agent')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const PEDIDOS_FILE = path.join(__dirname, 'pedidos_vistos.json')
const PRODUTOS_FILE = path.join(__dirname, 'produtos.json')
const RESPONDIDAS_FILE = path.join(__dirname, 'mensagens_respondidas.json')
let ultimoPedidoVisto = null
let emColeta = false  // mutex: nunca abre dois browsers ao mesmo tempo

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

let produtos = carregarJSON(PRODUTOS_FILE, {})
let mensagensRespondidas = carregarJSON(RESPONDIDAS_FILE, {})

// Notifica Zaya (Railway) via HTTP POST /notify-order
// Configure ZAYA_URL no .env: ex. ZAYA_URL=https://luna-bot-xxxx.up.railway.app
function notifyZaya(orderId) {
    const url = process.env.ZAYA_URL
    if (!url) {
        console.log(`⚠️  [Zyon] ZAYA_URL não definida — pedido #${orderId} detectado mas Zaya não notificada`)
        console.log(`   Adicione no .env: ZAYA_URL=https://seu-app.up.railway.app`)
        return
    }

    const data = JSON.stringify({ orderId })
    let parsedUrl
    try {
        parsedUrl = new URL(`${url}/notify-order`)
    } catch {
        console.error(`❌ [Zyon] ZAYA_URL inválida: ${url}`)
        return
    }

    const lib = parsedUrl.protocol === 'https:' ? https : http
    const port = parsedUrl.port
        ? Number(parsedUrl.port)
        : parsedUrl.protocol === 'https:' ? 443 : 80

    const req = lib.request({
        hostname: parsedUrl.hostname,
        port,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
        }
    }, (res) => {
        console.log(`📨 [Zyon] Zaya notificada (HTTP ${res.statusCode}): pedido #${orderId}`)
    })

    req.on('error', (err) => {
        console.error(`❌ [Zyon] Erro ao notificar Zaya: ${err.message}`)
    })

    req.write(data)
    req.end()
}

async function checarNovosPedidos() {
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

// Envia todos os dados Shopee para Zaya via POST /update-faturamento
function enviarDadosParaZaya(fatDia, fatMes, aEnviar) {
    const url = process.env.ZAYA_URL
    if (!url) {
        console.log('⚠️  [Zyon] ZAYA_URL não definida — dados não enviados à Zaya')
        return
    }

    const data = JSON.stringify({ fatDia, fatMes, aEnviar })
    let parsedUrl
    try { parsedUrl = new URL(`${url}/update-faturamento`) } catch {
        console.error(`❌ [Zyon] ZAYA_URL inválida: ${url}`)
        return
    }

    const lib = parsedUrl.protocol === 'https:' ? https : http
    const port = parsedUrl.port ? Number(parsedUrl.port) : (parsedUrl.protocol === 'https:' ? 443 : 80)

    const req = lib.request({
        hostname: parsedUrl.hostname,
        port,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
        console.log(`📨 [Zyon] Dados enviados à Zaya (HTTP ${res.statusCode}) — Dia: R$ ${fatDia || '?'}, Mês: R$ ${fatMes || '?'}, A Enviar: ${aEnviar || '?'}`)
    })
    req.on('error', err => console.error(`❌ [Zyon] Erro ao enviar dados: ${err.message}`))
    req.write(data)
    req.end()
}

async function coletarEEnviarDados() {
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

        console.log(`💰 [Zyon] Dia: R$ ${fatDia || '?'} | Mês: R$ ${fatMes || '?'} | A Enviar: ${aEnviar || '?'}`)
        enviarDadosParaZaya(fatDia, fatMes, aEnviar)
    } catch (err) {
        console.error('❌ [Zyon] Erro ao coletar dados Shopee:', err.message)
    } finally {
        emColeta = false
    }
}

// ───────────────────────── Atendimento automático via Chat ─────────────────────────

const CHAT_SYSTEM_PROMPT = `Você é Zyon, assistente virtual de atendimento ao cliente da loja.

Na primeira mensagem de cada conversa, apresente-se: "Olá! Sou o Zyon, assistente virtual da loja. Estou aqui para te ajudar! 😊 A qualquer momento você pode digitar *falar com atendente* para ser atendido por um humano."

INSTRUÇÕES GERAIS
- Responda apenas utilizando informações presentes na Base de Conhecimento e no anúncio do produto.
- Quando precisar confirmar características, medidas, cores, materiais, personalizações ou especificações, consulte o anúncio do produto.
- Se uma informação não estiver disponível no anúncio ou na Base de Conhecimento, responda: "No momento não temos essa informação."
- Nunca invente informações.
- Seja cordial, objetivo e profissional.
- Sempre que o cliente digitar "falar com atendente", responda: "Certo! Vou chamar um atendente para você. Antes, aqui está um resumo da nossa conversa: [resumo]. Em breve alguém entrará em contato. 😊"

BASE DE CONHECIMENTO
ATRASO NA ENTREGA: Orientar o cliente a entrar em contato com a plataforma, pois não há acesso às informações logísticas.
DEVOLUÇÃO E REEMBOLSO: O cliente pode solicitar devolução em até 30 dias após o recebimento diretamente nos detalhes da compra.
GARANTIA: Garantia de 30 dias após o recebimento.
TROCAS: A plataforma não realiza trocas. Orientar o cliente a solicitar a devolução e realizar uma nova compra.
CAMISETA DO BRASIL: Solicitar nome e número do cliente.
PERSONALIZAÇÃO DOS DEMAIS PRODUTOS: O cliente deve enviar a arte final pronta pelo chat. Não criamos arte. Solicitar que o cliente confira se a imagem está em boa resolução antes do envio. Não nos responsabilizamos por imagens enviadas com baixa qualidade. Áreas máximas de personalização: Frente A3, Costas A3, Frente e costas: Frente 9x9cm / Costas 28x28cm. Essas regras não se aplicam à Camiseta do Brasil.
PEDIDOS A ENVIAR OU CLIENTES COBRANDO POSICIONAMENTO: Responder "No momento estamos com uma alta demanda de pedidos e nossa equipe está trabalhando para liberar todos os pedidos o mais rápido possível."

QUANDO NÃO RESPONDER E ENCAMINHAR PARA ANÁLISE HUMANA:
- Cliente solicitar "falar com atendente"
- Problemas de estoque
- Reclamações complexas
- Solicitações de exceção
- Divergência entre anúncio e Base de Conhecimento
- Necessidade de autorização especial
- Assuntos não previstos no anúncio ou na Base de Conhecimento

EM TODOS OS CASOS DE ENCAMINHAMENTO HUMANO:
1. Gerar resumo da conversa com: nome do cliente, produto envolvido, motivo do contato, o que foi tentado resolver e por que precisa de atendimento humano
2. Enviar o resumo para o cliente no chat
3. Notificar o dono via Zaya com o resumo completo`

// Pede à IA a resposta ao cliente e, no mesmo retorno em JSON, se a conversa precisa
// de atendimento humano e o resumo a enviar ao dono — assim o código decide com segurança
// sem depender de interpretar texto livre.
async function gerarRespostaChat(nomeCliente, mensagens, infoProduto, primeiraMensagem) {
    const transcricao = mensagens.map(m => `${m.remetente === 'cliente' ? 'Cliente' : 'Loja'}: ${m.texto}`).join('\n')

    const contextoProduto = infoProduto
        ? `\n\nINFORMAÇÕES DO ANÚNCIO DO PRODUTO EM DISCUSSÃO (use como referência):\n${JSON.stringify(infoProduto).substring(0, 4000)}`
        : '\n\nNenhuma informação de produto disponível para esta conversa — se a dúvida depender do anúncio, responda "No momento não temos essa informação."'

    const formatoSaida = `\n\nResponda EXCLUSIVAMENTE em JSON, neste formato exato (sem texto fora do JSON):
{"precisaHumano": true ou false, "resposta": "mensagem a enviar ao cliente agora no chat — a resposta normal de atendimento, ou, quando precisaHumano for true, a mensagem de encaminhamento com o resumo já embutido conforme instruído", "resumoParaDono": "resumo completo da conversa (nome do cliente, produto, motivo do contato, o que já foi tentado e por que precisa de humano) — use null quando precisaHumano for false"}`

    const messages = [{ role: 'system', content: CHAT_SYSTEM_PROMPT + contextoProduto + formatoSaida }]
    if (primeiraMensagem) {
        messages.push({ role: 'system', content: 'Esta é a primeira mensagem desta conversa — comece com a apresentação indicada nas instruções.' })
    }
    messages.push({ role: 'user', content: `Cliente: ${nomeCliente}\n\nConversa completa até agora:\n${transcricao}\n\nGere a próxima resposta da loja.` })

    const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 700,
        response_format: { type: 'json_object' },
        messages,
    })

    try {
        return JSON.parse(response.choices[0].message.content)
    } catch (err) {
        console.error('❌ [Zyon/chat] IA não retornou JSON válido:', err.message)
        return { precisaHumano: false, resposta: 'No momento não temos essa informação.', resumoParaDono: null }
    }
}

// Notifica o dono (via Zaya) quando uma conversa precisa de atendimento humano
function notificarAtendimentoHumano(nomeCliente, ultimaMensagem, resumo) {
    const url = process.env.ZAYA_URL
    if (!url) {
        console.log(`⚠️  [Zyon] ZAYA_URL não definida — ${nomeCliente} precisa de atendimento humano, mas Zaya não foi notificada`)
        return
    }

    const data = JSON.stringify({ nomeCliente, ultimaMensagem, resumo })
    let parsedUrl
    try { parsedUrl = new URL(`${url}/notify-chat-human`) } catch {
        console.error(`❌ [Zyon] ZAYA_URL inválida: ${url}`)
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
        console.log(`📨 [Zyon] Dono notificado para atendimento humano (HTTP ${res.statusCode}): ${nomeCliente}`)
    })
    req.on('error', err => console.error(`❌ [Zyon] Erro ao notificar atendimento humano: ${err.message}`))
    req.write(data)
    req.end()
}

// Retorna as informações do produto a partir do cache em produtos.json (chave = produtoId,
// extraído diretamente do checkbox no painel da estação do chat — estável e confiável).
// Se ainda não estiver salvo, extrai do anúncio via Puppeteer (cadastro → 3 pontinhos →
// visualizar página) usando o nome para localizá-lo, e salva sob o produtoId vindo do chat.
async function obterInfoProduto(page, produtoId, produtoNome) {
    if (!produtoId && !produtoNome) return null

    if (produtoId && produtos[produtoId]) {
        console.log(`📦 [Zyon/produto] Usando dados salvos em produtos.json: #${produtoId} — ${produtos[produtoId].titulo}`)
        return produtos[produtoId]
    }
    if (!produtoNome) return null

    console.log(`🔎 [Zyon/produto] Produto #${produtoId || '?'} não encontrado em produtos.json — extraindo do anúncio: ${produtoNome}`)
    try {
        const info = await extrairInfoProduto(page, produtoNome)
        if (info) {
            const chave = produtoId || info.produtoId
            if (chave) {
                info.produtoId = chave
                produtos[chave] = info
                salvarJSON(PRODUTOS_FILE, produtos)
                console.log(`💾 [Zyon/produto] Salvo em produtos.json: #${chave} — ${info.titulo}`)
            }
        }
        return info
    } catch (err) {
        console.error(`❌ [Zyon/produto] Erro ao extrair informações do produto: ${err.message}`)
        return null
    }
}

// Processa a conversa atualmente aberta: lê o histórico, identifica o produto, gera a
// resposta com IA e envia — encaminhando para atendimento humano com resumo quando necessário
async function processarConversaAberta(page, nomeCliente) {
    const { mensagens, produtoId, produtoNome } = await lerConversaCompleta(page)
    if (mensagens.length === 0) return

    const ultimaMsgCliente = [...mensagens].reverse().find(m => m.remetente === 'cliente')
    if (!ultimaMsgCliente) return

    // A interface web do Shopee não expõe IDs estáveis de mensagem — usamos um identificador
    // baseado no conteúdo (cliente + última mensagem) para saber se já respondemos a ela
    const idMensagem = `${nomeCliente}::${ultimaMsgCliente.texto}`.substring(0, 200)
    if (mensagensRespondidas[nomeCliente] === idMensagem) {
        console.log(`⏭️  [Zyon/chat] ${nomeCliente}: última mensagem já respondida, pulando`)
        return
    }

    const primeiraMensagem = !mensagens.some(m => m.remetente === 'loja')
    console.log(`🧑 [Zyon/chat] ${nomeCliente} — produto: ${produtoNome || '(não identificado)'}${produtoId ? ` (#${produtoId})` : ''} — gerando resposta...`)

    const infoProduto = await obterInfoProduto(page, produtoId, produtoNome)
    const resultado = await gerarRespostaChat(nomeCliente, mensagens, infoProduto, primeiraMensagem)

    await enviarMensagemNoChat(page, resultado.resposta)

    if (resultado.precisaHumano) {
        console.log(`🙋 [Zyon/chat] ${nomeCliente}: encaminhado para atendimento humano`)
        notificarAtendimentoHumano(nomeCliente, ultimaMsgCliente.texto, resultado.resumoParaDono || resultado.resposta)
    }

    mensagensRespondidas[nomeCliente] = idMensagem
    salvarJSON(RESPONDIDAS_FILE, mensagensRespondidas)
}

// A cada 5 min: abre o chat e processa as conversas com mensagens não respondidas
async function verificarChatClientes() {
    if (emColeta) {
        console.log('⏭️  [Zyon] Browser ocupado — verificação de chat adiada')
        return
    }
    emColeta = true
    let browser
    try {
        console.log(`\n💬 [Zyon] Verificando chat de clientes... ${new Date().toLocaleTimeString('pt-BR')}`)
        browser = await launchBrowser(resolverChrome())
        const page = await browser.newPage()
        await page.setViewport({ width: 1366, height: 768 })
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' })

        await abrirChat(page)

        // Limite por ciclo evita ficar preso processando uma fila grande de uma só vez
        for (let i = 0; i < 5; i++) {
            const cliente = await abrirProximaConversaNaoRespondida(page)
            if (!cliente) break
            try {
                await processarConversaAberta(page, cliente)
            } catch (err) {
                console.error(`❌ [Zyon/chat] Erro ao processar conversa de ${cliente}: ${err.message}`)
            }
            await abrirChat(page) // volta à lista antes de procurar a próxima conversa pendente
        }
    } catch (err) {
        console.error('❌ [Zyon] Erro ao verificar chat:', err.message)
    } finally {
        if (browser) await browser.close()
        emColeta = false
    }
}

// Uma vez por dia: revisita os anúncios já salvos em produtos.json para capturar mudanças
async function atualizarProdutosSalvos() {
    const ids = Object.keys(produtos)
    if (ids.length === 0) return
    if (emColeta) {
        console.log('⏭️  [Zyon] Browser ocupado — atualização diária de produtos adiada')
        return
    }

    emColeta = true
    let browser
    try {
        console.log(`\n🔄 [Zyon] Atualizando ${ids.length} produto(s) salvos em produtos.json — ${new Date().toLocaleTimeString('pt-BR')}`)
        browser = await launchBrowser(resolverChrome())
        const page = await browser.newPage()
        await page.setViewport({ width: 1366, height: 768 })
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' })

        for (const id of ids) {
            try {
                const info = await extrairInfoProduto(page, produtos[id].titulo)
                if (info && info.produtoId) {
                    produtos[info.produtoId] = info
                    console.log(`🔄 [Zyon/produto] Atualizado: #${info.produtoId} — ${info.titulo}`)
                }
            } catch (err) {
                console.error(`❌ [Zyon/produto] Erro ao atualizar produto #${id}: ${err.message}`)
            }
        }
        salvarJSON(PRODUTOS_FILE, produtos)
    } catch (err) {
        console.error('❌ [Zyon] Erro na atualização diária de produtos:', err.message)
    } finally {
        if (browser) await browser.close()
        emColeta = false
    }
}

const INTERVALO_MS = 3 * 60 * 1000
const INTERVALO_DADOS_MS = 30 * 60 * 1000
const INTERVALO_CHAT_MS = 5 * 60 * 1000
const INTERVALO_PRODUTOS_MS = 24 * 60 * 60 * 1000
const ZYON_PORT = Number(process.env.ZYON_PORT) || 3001

// Servidor HTTP: recebe solicitações imediatas da Zaya
const zyonServer = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/solicitar-faturamento') {
        console.log(`\n📥 [Zyon] Coleta imediata solicitada pela Zaya — ${new Date().toLocaleTimeString('pt-BR')}`)
        await coletarEEnviarDados()
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
    } else {
        res.writeHead(404)
        res.end()
    }
})
zyonServer.listen(ZYON_PORT, () => {
    console.log(`🌐 Zyon HTTP server escutando na porta ${ZYON_PORT}`)
})

console.log('⚡ Zyon iniciado — monitoramento de pedidos e atendimento Shopee')
console.log(`🔁 Pedidos novos: a cada ${INTERVALO_MS / 60000} min | Dados completos: a cada ${INTERVALO_DADOS_MS / 60000} min | Chat: a cada ${INTERVALO_CHAT_MS / 60000} min`)
console.log(`📡 Zaya URL: ${process.env.ZAYA_URL || '(não configurada — defina ZAYA_URL no .env)'}`)
console.log('─────────────────────────────────────────────────')

// Executa em sequência na inicialização (nunca dois browsers ao mesmo tempo)
;(async () => {
    await checarNovosPedidos()
    await coletarEEnviarDados()
    await verificarChatClientes()
})()
setInterval(checarNovosPedidos, INTERVALO_MS)
setInterval(coletarEEnviarDados, INTERVALO_DADOS_MS)
setInterval(verificarChatClientes, INTERVALO_CHAT_MS)
setInterval(atualizarProdutosSalvos, INTERVALO_PRODUTOS_MS)
