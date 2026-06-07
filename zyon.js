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
    launchBrowser, resolverChrome,
    abrirChat, abrirProximaConversaNaoRespondida, lerConversaCompleta, enviarMensagemNoChat, extrairInfoProduto,
} = require('./shopee-agent')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const PEDIDOS_FILE = path.join(__dirname, 'pedidos_vistos.json')
const PRODUTOS_FILE = path.join(__dirname, 'produtos.json')
const RESPONDIDAS_FILE = path.join(__dirname, 'mensagens_respondidas.json')
let ultimoPedidoVisto = null
let emColeta = false  // mutex: nunca abre dois browsers ao mesmo tempo

// Registro do horário da última execução de cada tarefa periódica — usado pelo watchdog
// para detectar se algum setInterval travou/parou e precisa ser reiniciado
const ultimaExecucao = {
    pedidos: Date.now(),
    dados: Date.now(),
    chat: Date.now(),
}

// Executa uma tarefa periódica isolando erros — assim uma falha não derruba o processo
// nem impede que as demais tarefas continuem rodando nos seus próprios intervalos
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

Na primeira mensagem de cada conversa, apresente-se: "Olá! Sou o Zyon, assistente virtual da loja. Estou aqui para te ajudar! 😊"

INSTRUÇÕES GERAIS
- LEIA A CONVERSA INTEIRA antes de responder, do início ao fim — não responda apenas isolando a última mensagem do cliente. Várias vezes o cliente pergunta algo no começo e a dúvida já foi esclarecida mais adiante na própria conversa (pelo cliente ou pela loja); nesses casos NÃO repita uma resposta para algo que já foi resolvido — identifique qual é o ponto mais atual e ainda em aberto e responda a ele. Se útil, baseie sua resposta num resumo mental de tudo que já foi tratado, para não se perder no histórico.
- Preste atenção a imagens/arquivos enviados pelo cliente (marcados na conversa como "[imagem/arquivo enviado]" em mensagens com remetente "Cliente") — eles fazem parte do contexto: podem ser a arte para personalização, comprovante, foto do produto recebido, foto da estampa, etc. Leve isso em conta ao decidir o que já foi resolvido e o que ainda precisa de resposta.
- ATENÇÃO — NÃO CONFUNDIR IMAGEM DO CLIENTE COM CARD DO PRODUTO: o card/resumo do produto que aparece no início da conversa (com foto, título e preço do anúncio) é informação do PEDIDO, gerada automaticamente pela plataforma — NUNCA é uma imagem ou arte enviada pelo cliente. Considere como "imagem enviada pelo cliente" SOMENTE os itens marcados "[imagem/arquivo enviado]" dentro de mensagens cujo remetente seja "Cliente" na transcrição da conversa. Se o cliente não enviou nenhuma mensagem com esse marcador, ele NÃO enviou imagem — responda normalmente ao texto dele, sem mencionar ou agradecer por uma imagem que não existe.
- Responda apenas utilizando informações presentes na Base de Conhecimento e no anúncio do produto.
- Quando precisar confirmar características, medidas, cores, materiais, personalizações ou especificações, consulte o anúncio do produto.
- Se uma informação não estiver disponível no anúncio ou na Base de Conhecimento, responda: "No momento não temos essa informação."
- Nunca invente informações.
- Seja cordial, objetivo e profissional.
- RESPOSTAS CURTAS: para perguntas diretas e simples, responda em no máximo 3 linhas — direto ao ponto, sem rodeios nem explicações longas desnecessárias. Se não tiver certeza absoluta da resposta, NÃO especule nem tente "completar" a informação por conta própria — prefira encaminhar para atendimento humano (precisaHumano = true) a arriscar uma resposta incorreta.
- Sempre que o cliente digitar "falar com atendente", responda: "Certo! Vou chamar um atendente para você. Antes, aqui está um resumo da nossa conversa: [resumo]. Em breve alguém entrará em contato. 😊"
- RESUMO FINAL PARA HUMANO: sempre que a conversa for encaminhada para atendimento humano (precisaHumano = true), o campo "resumoParaDono" deve ser preenchido OBRIGATORIAMENTE neste formato exato:
"📋 *Resumo para atendimento:*
- Cliente: [nome]
- Pedido: [id do pedido se disponível, ou "não informado"]
- Assunto: [motivo do contato]
- O que foi tratado: [resumo do que foi discutido]
- O que precisa ser feito: [ação necessária]"
- INFORMAÇÕES IMPORTANTES DO CLIENTE: sempre que o cliente fornecer NESTA interação uma informação relevante para o atendimento — área de personalização, nome, número, observação especial, prazo urgente, reclamação — preencha o campo "informacaoImportante" com uma frase curta e objetiva descrevendo o que foi informado (ex: "Cliente pediu personalização no lado direito do peito", "Cliente informou nome e número para a Camiseta do Brasil: João, 42"). Use null quando nada relevante foi informado nesta interação. Não repita uma informação já sinalizada em mensagens anteriores.
- ÚLTIMA MENSAGEM: O Zyon deve sempre ser o último a responder na conversa. Quando o cliente encerrar com "ok", "obrigado", "entendi" ou similar — ou enviar um adesivo, figurinha, emoji, imagem sem texto, ou qualquer mensagem que indique que a conversa está sendo encerrada — responda com uma mensagem curta e cordial de encerramento. Exemplos:
"Fico à disposição! 😊"
"Qualquer dúvida, estamos aqui! 😊"
"Foi um prazer ajudar! Estamos à disposição. 😊"
"Obrigado pelo contato! Estamos à disposição. 😊"
"Foi um prazer! Qualquer dúvida, estamos aqui. 😊"
Não envie mais de uma mensagem de encerramento. Se já houver uma mensagem de encerramento do Zyon como última mensagem, não envie outra.

BASE DE CONHECIMENTO
ATRASO NA ENTREGA: Orientar o cliente a entrar em contato com a plataforma, pois não há acesso às informações logísticas.
DEVOLUÇÃO E REEMBOLSO: O cliente pode solicitar devolução em até 30 dias após o recebimento diretamente nos detalhes da compra.
GARANTIA: Garantia de 30 dias após o recebimento.
TROCAS: A plataforma não realiza trocas. Orientar o cliente a solicitar a devolução e realizar uma nova compra.
CAMISETA DO BRASIL: Solicitar nome e número do cliente.
PERSONALIZAÇÃO DOS DEMAIS PRODUTOS: O cliente deve enviar a arte final pronta pelo chat. Não criamos arte. Solicitar que o cliente confira se a imagem está em boa resolução antes do envio. Não nos responsabilizamos por imagens enviadas com baixa qualidade. Áreas máximas de personalização: Frente A3, Costas A3, Frente e costas: Frente 9x9cm / Costas 28x28cm. Essas regras não se aplicam à Camiseta do Brasil. Quando o cliente enviar uma foto do produto vestido ou uma foto tirada com celular da estampa, oriente que isso não é a arte adequada para personalização — a arte precisa ser o ARQUIVO da estampa (PNG com fundo transparente, preferencialmente). Exemplo de resposta: "Para personalização, precisamos do arquivo da arte em si, preferencialmente em PNG com fundo transparente — não uma foto da camiseta ou imagem tirada com celular. Você tem o arquivo da estampa? Pode ser enviado aqui no chat mesmo."
CRIAÇÃO DE ARTE: A loja NÃO cria arte. O cliente deve enviar a arte final pronta. Nunca confirme, prometa ou sugira que a loja cria, desenha ou desenvolve artes — em nenhuma hipótese. Se ao ler o histórico você perceber que uma mensagem anterior da própria loja deu a entender que a arte seria criada pela loja, corrija educadamente nesta resposta com: "Pedimos desculpas pela confusão! Trabalhamos com personalização a partir da arte enviada pelo cliente — não criamos a arte do zero. Você precisaria enviar o arquivo da estampa pronto para prosseguirmos. 😊"
PEDIDOS GRANDES / FARDAMENTO / ATACADO: Quando o cliente mencionar fardamento, pedido em quantidade (acima de 5 unidades), compra no atacado ou pedido corporativo, encaminhe IMEDIATAMENTE para atendimento humano (precisaHumano = true) — não tente negociar, orçar ou resolver por conta própria. Responda: "Para pedidos em maior quantidade ou fardamentos, vou encaminhar para um de nossos atendentes que poderá te ajudar melhor! 😊"
CLIENTE INSATISFEITO OU RECLAMANDO: Quando o cliente demonstrar insatisfação, raiva ou reclamação — inclusive sobre uma informação recebida anteriormente na própria conversa — encaminhe para atendimento humano (precisaHumano = true) com o resumo completo da situação no campo "resumoParaDono", explicando o que gerou a insatisfação.
PEDIDOS A ENVIAR OU CLIENTES COBRANDO POSICIONAMENTO: Responder "No momento estamos com uma alta demanda de pedidos e nossa equipe está trabalhando para liberar todos os pedidos o mais rápido possível."
PRAZO DE POSTAGEM / ENTREGA: Verifique o prazo de envio informado no cabeçalho da conversa. Se disponível, informe ao cliente: "O prazo de envio do seu pedido é até [prazoEnvio]. Após a postagem, o prazo de entrega é gerenciado pela Shopee. Para mais detalhes sobre rastreamento ou atrasos, você pode falar diretamente com a Shopee pelo chat deles. 😊"
CONFIRMAÇÃO DE ÁREA DE PERSONALIZAÇÃO: Sempre que o cliente enviar a arte para personalização, após confirmar o recebimento e a qualidade, pergunte em qual área deseja a personalização. Resposta sugerida: "A personalização será só no peito, nas costas, ou frente e costas? 😊"
ARTE JÁ ENVIADA: Antes de pedir a arte de personalização, verifique no histórico se há alguma mensagem do CLIENTE marcada como "[imagem/arquivo enviado]" (ignore o card do produto no início da conversa — isso é informação do pedido, não uma arte enviada pelo cliente). Se o cliente já enviou, NÃO peça a arte novamente — reconheça que ela foi recebida e avance para a próxima etapa (confirmar qualidade, área de personalização, etc). Se o cliente NÃO enviou nenhuma imagem/arquivo, não diga que recebeu nada — siga normalmente a orientação de PERSONALIZAÇÃO DOS DEMAIS PRODUTOS.
LOCALIZAÇÃO DA ARTE: Quando o cliente informar onde quer a personalização (ex: "lado direito do peito", "costas", "frente"), confirme a informação e registre. Resposta sugerida: "Perfeito! Arte no [local informado]. Vou registrar isso para a produção. ✅"
SUGESTÃO DE PRODUTOS: Quando o contexto da conversa permitir (cliente perguntando sobre outros produtos, cliente que fez um pedido pequeno, cliente satisfeito, etc), você pode sugerir outros produtos da loja com o link direto, usando a lista de OUTROS PRODUTOS DA LOJA fornecida no contexto (use o link exatamente como informado). Se não houver outros produtos disponíveis no contexto, não sugira nenhum. Exemplo de resposta: "Aproveite e conheça também nossos outros modelos! 😊 [link do produto]"

QUANDO NÃO RESPONDER E ENCAMINHAR PARA ANÁLISE HUMANA:
- Cliente solicitar "falar com atendente"
- Problemas de estoque
- Reclamações complexas
- Solicitações de exceção
- Divergência entre anúncio e Base de Conhecimento
- Necessidade de autorização especial
- Assuntos não previstos no anúncio ou na Base de Conhecimento
- Pedidos grandes, fardamento, atacado ou pedido corporativo (ver PEDIDOS GRANDES / FARDAMENTO / ATACADO)
- Cliente insatisfeito, irritado ou reclamando — inclusive de algo dito anteriormente na conversa (ver CLIENTE INSATISFEITO OU RECLAMANDO)

EM TODOS OS CASOS DE ENCAMINHAMENTO HUMANO:
1. Gerar resumo da conversa com: nome do cliente, produto envolvido, motivo do contato, o que foi tentado resolver e por que precisa de atendimento humano
2. Enviar o resumo para o cliente no chat
3. Notificar o dono via Zaya com o resumo completo`

// Pede à IA a resposta ao cliente e, no mesmo retorno em JSON, se a conversa precisa
// de atendimento humano e o resumo a enviar ao dono — assim o código decide com segurança
// sem depender de interpretar texto livre.
async function gerarRespostaChat(nomeCliente, mensagens, infoProduto, primeiraMensagem, prazoEnvio) {
    const transcricao = mensagens.map(m => `${m.remetente === 'cliente' ? 'Cliente' : 'Loja'}: ${m.texto}`).join('\n')

    const contextoProduto = infoProduto
        ? `\n\nINFORMAÇÕES DO ANÚNCIO DO PRODUTO EM DISCUSSÃO (use como referência):\n${JSON.stringify(infoProduto).substring(0, 4000)}`
        : '\n\nNenhuma informação de produto disponível para esta conversa — se a dúvida depender do anúncio, responda "No momento não temos essa informação."'

    const contextoPrazo = prazoEnvio
        ? `\n\nPRAZO DE ENVIO DESTE PEDIDO (extraído do cabeçalho da conversa): ${prazoEnvio}`
        : '\n\nNenhum prazo de envio identificado no cabeçalho desta conversa — se o cliente perguntar sobre prazo, responda "No momento não temos essa informação."'

    // Catálogo de outros produtos já conhecidos (cache local) para a instrução SUGESTÃO DE
    // PRODUTOS — sem isso a IA não teria links reais para oferecer. Exclui o produto em discussão.
    const outrosProdutos = Object.values(produtos)
        .filter(p => p.titulo && p.url && p.produtoId !== infoProduto?.produtoId)
        .map(p => `- ${p.titulo}: ${p.url}`)
    const contextoCatalogo = outrosProdutos.length
        ? `\n\nOUTROS PRODUTOS DA LOJA DISPONÍVEIS PARA SUGESTÃO (use o link exatamente como informado):\n${outrosProdutos.join('\n').substring(0, 2000)}`
        : '\n\nNenhum outro produto disponível no catálogo local para sugestão no momento — não sugira produtos nesta conversa.'

    const formatoSaida = `\n\nResponda EXCLUSIVAMENTE em JSON, neste formato exato (sem texto fora do JSON):
{"precisaHumano": true ou false, "resposta": "mensagem a enviar ao cliente agora no chat — a resposta normal de atendimento, ou, quando precisaHumano for true, a mensagem de encaminhamento com o resumo já embutido conforme instruído", "resumoParaDono": "resumo completo da conversa no formato indicado em RESUMO FINAL PARA HUMANO — use null quando precisaHumano for false", "informacaoImportante": "frase curta descrevendo uma informação relevante fornecida pelo cliente NESTA interação, conforme INFORMAÇÕES IMPORTANTES DO CLIENTE — use null quando nada relevante foi informado agora"}`

    const messages = [{ role: 'system', content: CHAT_SYSTEM_PROMPT + contextoProduto + contextoPrazo + contextoCatalogo + formatoSaida }]
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
        return { precisaHumano: false, resposta: 'No momento não temos essa informação.', resumoParaDono: null, informacaoImportante: null }
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

// Notifica o dono (via Zaya) quando o cliente fornece, durante o atendimento, uma informação
// importante (área de personalização, nome/número, observação especial, prazo urgente, reclamação)
function notificarAtualizacaoAtendimento(nomeCliente, informacao) {
    const url = process.env.ZAYA_URL
    if (!url) {
        console.log(`⚠️  [Zyon] ZAYA_URL não definida — informação importante de ${nomeCliente} não notificada: ${informacao}`)
        return
    }

    const data = JSON.stringify({ nomeCliente, informacao })
    let parsedUrl
    try { parsedUrl = new URL(`${url}/notify-chat-update`) } catch {
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
        console.log(`📌 [Zyon] Dono notificado sobre informação importante (HTTP ${res.statusCode}): ${nomeCliente} — ${informacao}`)
    })
    req.on('error', err => console.error(`❌ [Zyon] Erro ao notificar informação importante: ${err.message}`))
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
    const { mensagens, produtoId, produtoNome, prazoEnvio } = await lerConversaCompleta(page)
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
    const resultado = await gerarRespostaChat(nomeCliente, mensagens, infoProduto, primeiraMensagem, prazoEnvio)

    await enviarMensagemNoChat(page, resultado.resposta)

    if (resultado.precisaHumano) {
        console.log(`🙋 [Zyon/chat] ${nomeCliente}: encaminhado para atendimento humano`)
        notificarAtendimentoHumano(nomeCliente, ultimaMsgCliente.texto, resultado.resumoParaDono || resultado.resposta)
    }

    if (resultado.informacaoImportante) {
        console.log(`📌 [Zyon/chat] ${nomeCliente}: informação importante identificada — ${resultado.informacaoImportante}`)
        notificarAtualizacaoAtendimento(nomeCliente, resultado.informacaoImportante)
    }

    mensagensRespondidas[nomeCliente] = idMensagem
    salvarJSON(RESPONDIDAS_FILE, mensagensRespondidas)
}

// A cada 5 min: abre o chat e processa as conversas com mensagens não respondidas
// Roda `tarefa(browser, page)` num browser novo. Se o browser do Puppeteer fechar
// inesperadamente (crash do Chrome, processo morto, etc.) durante a execução, a Promise
// pendente é rejeitada (em vez de ficar travada para sempre), o browser é relançado
// automaticamente e a operação é tentada mais uma vez.
async function executarComBrowser(nomeOperacao, tarefa, tentativas = 2) {
    for (let tentativa = 1; tentativa <= tentativas; tentativa++) {
        let browser
        let fechouInesperadamente = false
        try {
            browser = await launchBrowser(resolverChrome())
            browser.once('disconnected', () => { fechouInesperadamente = true })

            const page = await browser.newPage()
            await page.setViewport({ width: 1366, height: 768 })
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' })

            const desconexao = new Promise((_, reject) => {
                browser.once('disconnected', () => reject(new Error(`Browser do Puppeteer fechou inesperadamente durante ${nomeOperacao}`)))
            })

            await Promise.race([tarefa(browser, page), desconexao])
            return
        } catch (err) {
            console.error(`❌ [Zyon] Erro em ${nomeOperacao} (tentativa ${tentativa}/${tentativas}):`, err.message)
            if (fechouInesperadamente && tentativa < tentativas) {
                console.log(`🔁 [Zyon] Reabrindo o browser e tentando "${nomeOperacao}" novamente...`)
                continue
            }
            throw err
        } finally {
            if (browser && browser.isConnected()) {
                try { await browser.close() } catch {}
            }
        }
    }
}

async function verificarChatClientes() {
    ultimaExecucao.chat = Date.now()
    if (emColeta) {
        console.log('⏭️  [Zyon] Browser ocupado — verificação de chat adiada')
        return
    }
    emColeta = true
    try {
        console.log(`\n💬 [Zyon] Verificando chat de clientes... ${new Date().toLocaleTimeString('pt-BR')}`)
        await executarComBrowser('verificação de chat', async (browser, page) => {
            await abrirChat(page)

            // Conversas já abertas neste ciclo — passadas como filtro para abrirProximaConversaNaoRespondida
            // para nunca reabrir a mesma conversa duas vezes na mesma rodada (evita loop)
            const conversasVisitadas = []

            // Limite por ciclo evita ficar preso processando uma fila grande de uma só vez
            for (let i = 0; i < 5; i++) {
                const cliente = await abrirProximaConversaNaoRespondida(page, conversasVisitadas)
                if (!cliente) break
                conversasVisitadas.push(cliente)
                try {
                    await processarConversaAberta(page, cliente)
                } catch (err) {
                    console.error(`❌ [Zyon/chat] Erro ao processar conversa de ${cliente}: ${err.message}`)
                }
                await abrirChat(page) // volta à lista antes de procurar a próxima conversa pendente
            }
        })
    } catch (err) {
        console.error('❌ [Zyon] Erro ao verificar chat:', err.message)
    } finally {
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
    try {
        console.log(`\n🔄 [Zyon] Atualizando ${ids.length} produto(s) salvos em produtos.json — ${new Date().toLocaleTimeString('pt-BR')}`)
        await executarComBrowser('atualização diária de produtos', async (browser, page) => {
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
        })
    } catch (err) {
        console.error('❌ [Zyon] Erro na atualização diária de produtos:', err.message)
    } finally {
        emColeta = false
    }
}

const INTERVALO_MS = 10 * 60 * 1000
const INTERVALO_DADOS_MS = 60 * 60 * 1000
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

// Referências dos setInterval ativos — guardadas para que o watchdog possa derrubar e
// recriar um intervalo travado sem duplicar execuções
let intervaloPedidosRef = null
let intervaloChatRef = null
let intervaloProdutosRef = null
let intervaloDadosRef = null

function iniciarMonitoramentoPedidos() {
    if (intervaloPedidosRef) clearInterval(intervaloPedidosRef)
    intervaloPedidosRef = setInterval(() => executarComSeguranca('checarNovosPedidos', checarNovosPedidos), INTERVALO_MS)
}
function iniciarMonitoramentoChat() {
    if (intervaloChatRef) clearInterval(intervaloChatRef)
    intervaloChatRef = setInterval(() => executarComSeguranca('verificarChatClientes', verificarChatClientes), INTERVALO_CHAT_MS)
}
function iniciarAtualizacaoProdutos() {
    if (intervaloProdutosRef) clearInterval(intervaloProdutosRef)
    intervaloProdutosRef = setInterval(() => executarComSeguranca('atualizarProdutosSalvos', atualizarProdutosSalvos), INTERVALO_PRODUTOS_MS)
}

// Agenda a coleta de faturamento para disparar exatamente no início de cada hora
// (1h00, 2h00, ...), aguardando com setTimeout até a próxima hora cheia e então
// passando a rodar a cada 60 min — assim o relatório sempre bate na hora certa.
function agendarColetaDeDadosNaHoraCheia() {
    if (intervaloDadosRef) {
        clearInterval(intervaloDadosRef)
        intervaloDadosRef = null
    }

    const agora = new Date()
    const proximaHora = new Date(agora)
    proximaHora.setHours(proximaHora.getHours() + 1, 0, 0, 0)
    const msAteProximaHora = proximaHora - agora

    console.log(`🕐 [Zyon] Próxima coleta de faturamento agendada para ${proximaHora.toLocaleTimeString('pt-BR')} (em ${Math.round(msAteProximaHora / 60000)} min)`)

    setTimeout(() => {
        executarComSeguranca('coletarEEnviarDados', coletarEEnviarDados)
        intervaloDadosRef = setInterval(() => executarComSeguranca('coletarEEnviarDados', coletarEEnviarDados), INTERVALO_DADOS_MS)
    }, msAteProximaHora)
}

// Watchdog: a cada 5 min verifica se cada tarefa periódica realmente rodou dentro do
// prazo esperado (com tolerância). Se alguma ficou parada — setInterval perdido,
// processo travado, etc. — recria o agendamento e dispara uma execução imediata.
const WATCHDOG_INTERVALO_MS = 5 * 60 * 1000
const WATCHDOG_TOLERANCIA = 2.5

function verificarEReiniciarIntervalos() {
    const agora = Date.now()

    if (agora - ultimaExecucao.pedidos > INTERVALO_MS * WATCHDOG_TOLERANCIA) {
        console.warn('🐶 [Zyon/watchdog] Monitoramento de pedidos parado — reiniciando...')
        ultimaExecucao.pedidos = agora
        iniciarMonitoramentoPedidos()
        executarComSeguranca('checarNovosPedidos', checarNovosPedidos)
    }

    if (agora - ultimaExecucao.chat > INTERVALO_CHAT_MS * WATCHDOG_TOLERANCIA) {
        console.warn('🐶 [Zyon/watchdog] Verificação de chat parada — reiniciando...')
        ultimaExecucao.chat = agora
        iniciarMonitoramentoChat()
        executarComSeguranca('verificarChatClientes', verificarChatClientes)
    }

    if (agora - ultimaExecucao.dados > INTERVALO_DADOS_MS * WATCHDOG_TOLERANCIA) {
        console.warn('🐶 [Zyon/watchdog] Coleta de faturamento parada — reiniciando...')
        ultimaExecucao.dados = agora
        agendarColetaDeDadosNaHoraCheia()
    }
}

// Executa em sequência na inicialização (nunca dois browsers ao mesmo tempo) — cada
// etapa isolada com executarComSeguranca para que uma falha não impeça as seguintes
;(async () => {
    await executarComSeguranca('checarNovosPedidos', checarNovosPedidos)
    await executarComSeguranca('coletarEEnviarDados', coletarEEnviarDados)
    await executarComSeguranca('verificarChatClientes', verificarChatClientes)
})()
iniciarMonitoramentoPedidos()
agendarColetaDeDadosNaHoraCheia()
iniciarMonitoramentoChat()
iniciarAtualizacaoProdutos()
setInterval(verificarEReiniciarIntervalos, WATCHDOG_INTERVALO_MS)
