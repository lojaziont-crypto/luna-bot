require('dotenv').config()

process.on('uncaughtException', (err) => {
    console.error('[ZVendas ERRO FATAL]', err.message)
})
process.on('unhandledRejection', (err) => {
    console.error('[ZVendas PROMISE REJEITADA]', err?.message || err)
})

const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const Anthropic = require('@anthropic-ai/sdk')
const { TERMOS_BUSCA, buscarEmpresasNoMaps: buscarEmpresasNoMapsCompartilhado, pareceCelular } = require('./maps-prospeccao')

const anthropic = new Anthropic({ timeout: 30000 }) // ANTHROPIC_API_KEY do .env

const esperar = ms => new Promise(r => setTimeout(r, ms))
const aleatorioEntre = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

const PORT = process.env.ZVENDAS_PORT || 3004
const ZAYA_URL = process.env.ZAYA_URL || 'http://localhost:3000'
const PIX_ZIONT = process.env.PIX_ZIONT || '45421352846'
const SHOPEE_LINK = process.env.SHOPEE_LINK || ''
const PROFILE_DIR = path.join(__dirname, 'zvendas_profile')
// ZVENDAS_MEMORIA_PATH permite testes/simulação apontarem pra um arquivo isolado —
// NUNCA testar contra o caminho padrão (é o estado real de produção).
const ARQUIVO_MEMORIA = process.env.ZVENDAS_MEMORIA_PATH || path.join(__dirname, 'zvendas_memoria.json')

// Nomes EXATOS das etiquetas já cadastradas no WhatsApp Business (Zaya cria se faltar,
// mas essas 6 já existem na conta — ver Zaya.js/garantirLabel).
const ETIQUETAS = {
    novoCliente: 'Novo cliente',
    emAndamento: 'Em andamento',
    propostaEnviada: 'Proposta enviada',
    cliente: 'Cliente',
    naoInteressado: 'Não interessado',
    seguirDepois: 'Seguir depois',
}

// ─────────────────────────────────────────────────────────────────────────────
// Memória persistente (zvendas_memoria.json)
// ─────────────────────────────────────────────────────────────────────────────

function memoriaPadrao() {
    return {
        // { nome, telefone, jid, status: 'pendente'|'contatado', etiqueta, dataContato, termoBusca,
        //   aguardandoResposta, followupsEnviados, dataUltimoFollowup, canal: 'zaya'|'matheus' } —
        //   canal decide quem aborda (ver proximoCanal); ausente = 'zaya' (registros de antes
        //   dessa divisão existir, todos contatados pelo número da Zaya). Os 3 campos de
        //   followup só se aplicam ao canal 'zaya' (ZMatheus não faz follow-up, ver spec).
        empresasContatadas: [],
        // { telefone, jid, nome, empresa, estagio, historico: [{de,texto,em}], dadosColetados: {} }
        conversasAtivas: [],
        // { numero, cliente, empresa, quantidade, tipo, arte, valor, dataEntrega, status, contato, criadoEm }
        pedidosFechados: [],
        // { idDecisao, telefone, jid, cliente, pedido, descontoSolicitado, criadoEm }
        aguardandoDesconto: [],
        contadorPedidos: 0,
        // Índice compartilhado entre ZVendas e ZMatheus (mesmo arquivo) — alterna a qual
        // canal cada NOVA empresa descoberta é atribuída (ver proximoCanal), garantindo
        // "empresa 1 → zaya, empresa 2 → matheus, empresa 3 → zaya..." independente de
        // qual dos dois processos a encontrou primeiro.
        proximoCanalIndex: 0,
        // { data: 'AAAA-MM-DD', quantidade, meta } — limite de 15-25 empresas novas/dia
        // (canal Zaya — descobertas por cicloProspeccao daqui, não por quantas de fato
        // acabam atribuídas a este canal, ver comentário em proximoCanal)
        contadorDiario: { data: null, quantidade: 0, meta: 0 },
        // Mesma coisa que contadorDiario, só que pro canal Matheus (zmatheus.js)
        contadorDiarioMatheus: { data: null, quantidade: 0, meta: 0 },
        // { data: 'AAAA-MM-DD', proximaBuscaNumero } — sequência progressiva de intervalos
        // entre buscas (1,2,4,8,16,32min, depois fixo 64min), reinicia por dia
        sequenciaBusca: { data: null, proximaBuscaNumero: 1 },
        // { atualizadoEm, produtos: [{nome, descricao, preco, moeda}] } — catálogo real do
        // WhatsApp Business, pra nunca inventar produto que não existe.
        catalogo: { atualizadoEm: null, produtos: [] },
        // { "Nome do produto": ["Cor1", "Cor2", ...] } — cores realmente disponíveis por
        // produto, cadastrado manualmente (o catálogo automático do WhatsApp não trouxe
        // essa granularidade). Usado pra nunca inventar cor que não existe.
        coresPorProduto: {
            'Camisa Polo Piquet Poliéster Personalizada': ['Amarelo', 'Azul-claro', 'Azul-marinho', 'Branco', 'Cinza', 'Creme', 'Preto', 'Vermelho', 'Vinho'],
        },
    }
}

function carregarMemoria() {
    try {
        if (!fs.existsSync(ARQUIVO_MEMORIA)) return memoriaPadrao()
        return { ...memoriaPadrao(), ...JSON.parse(fs.readFileSync(ARQUIVO_MEMORIA, 'utf8')) }
    } catch (err) {
        console.error('⚠️ [ZVendas] Erro ao carregar zvendas_memoria.json, usando padrão:', err.message)
        return memoriaPadrao()
    }
}

function salvarMemoria(mem) {
    try {
        fs.writeFileSync(ARQUIVO_MEMORIA, JSON.stringify(mem, null, 2), 'utf8')
    } catch (err) {
        console.error('⚠️ [ZVendas] Erro ao salvar zvendas_memoria.json:', err.message)
    }
}

// A Fase 1 (prospecção), Fase 2 (abordagem) e Fase 3 (atendimento) rodam em paralelo
// (setTimeout/webhooks independentes) e cada uma faz carregarMemoria→muta→salvarMemoria.
// Sem serialização, duas operações concorrentes perdiam a escrita uma da outra (ex:
// abordarEmpresa aplicava a etiqueta de verdade mas o status "contatado" nunca era salvo
// porque um ciclo de prospecção concorrente sobrescrevia o arquivo por cima). comMemoria
// serializa todo mutator via uma fila de promises — só um acesso a zvendas_memoria.json
// por vez, na ordem de chegada.
let filaMemoria = Promise.resolve()
function comMemoria(mutador) {
    const resultado = filaMemoria.then(async () => {
        const mem = carregarMemoria()
        const retorno = await mutador(mem)
        salvarMemoria(mem)
        return retorno
    })
    filaMemoria = resultado.then(() => {}, () => {})
    return resultado
}

// O Claude ocasionalmente retorna placeholders tipo "<UNKNOWN>"/"unknown"/"N/A" em vez
// de null pra um campo que não sabe — sem esse filtro, esses placeholders "válidos" (não
// são null/undefined/'') acabavam sobrescrevendo dados bons já coletados antes.
const PLACEHOLDERS_DESCONHECIDO = new Set(['<unknown>', 'unknown', 'n/a', 'na', 'desconhecido', 'não informado', 'nao informado', 'null', 'undefined'])
function ehValorColetadoValido(v) {
    if (v === null || v === undefined || v === '') return false
    if (typeof v === 'string' && PLACEHOLDERS_DESCONHECIDO.has(v.trim().toLowerCase())) return false
    return true
}

function normalizarTelefone(tel) {
    // Remove domínio (@s.whatsapp.net) e sufixo de dispositivo (:0) ANTES de tirar os
    // não-dígitos — senão um ":0" no JID vira um "0" grudado no fim do número.
    return String(tel || '').replace(/@.*$/, '').replace(/:.*$/, '').replace(/\D/g, '').replace(/^55/, '')
}

// Decide o canal ('zaya' ou 'matheus') de uma empresa RECÉM-DESCOBERTA, alternando
// a cada chamada via mem.proximoCanalIndex (persistido, compartilhado entre os dois
// processos — ver comentário em memoriaPadrao). DEVE ser chamado só dentro de um
// mutator comMemoria (muta mem.proximoCanalIndex direto, quem chama salva). Como é
// quem DESCOBRE a empresa que decide o canal (não necessariamente quem vai abordar),
// zvendas.js pode inserir uma empresa marcada 'matheus' — ela fica pendente até o
// próprio zmatheus.js (rodando como outro processo) passar e abordar; o inverso
// também acontece. Isso é o que garante a alternância "empresa 1→zaya, 2→matheus,
// 3→zaya..." de verdade, independente de qual processo achou cada uma.
// Risco aceito (mesmo padrão já usado em todo o resto do arquivo): comMemoria só
// serializa dentro de UM processo — dois processos gravando quase ao mesmo tempo
// podem, em teoria, perder um incremento do índice (a alternância fica "quase"
// perfeita, não estritamente garantida). Não há lock de arquivo entre processos
// neste projeto hoje (Zaya.js/zyon.js/zvendas.js já coexistem assim).
function proximoCanal(mem) {
    const idx = mem.proximoCanalIndex || 0
    mem.proximoCanalIndex = idx + 1
    return idx % 2 === 0 ? 'zaya' : 'matheus'
}

// ─────────────────────────────────────────────────────────────────────────────
// Cliente HTTP pra falar com a Zaya (que segura a sessão WhatsApp de verdade)
// ─────────────────────────────────────────────────────────────────────────────

function zayaRequest(urlPath, dadosEnvio) {
    return new Promise((resolve, reject) => {
        let parsedUrl
        try { parsedUrl = new URL(`${ZAYA_URL}${urlPath}`) } catch {
            return reject(new Error(`ZAYA_URL inválida: ${ZAYA_URL}`))
        }
        const lib = parsedUrl.protocol === 'https:' ? https : http
        const port = parsedUrl.port ? Number(parsedUrl.port) : (parsedUrl.protocol === 'https:' ? 443 : 80)
        const data = JSON.stringify(dadosEnvio || {})

        const req = lib.request({
            hostname: parsedUrl.hostname,
            port,
            path: parsedUrl.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, res => {
            let corpo = ''
            res.on('data', chunk => { corpo += chunk })
            res.on('end', () => {
                try { resolve(JSON.parse(corpo)) } catch { resolve({ ok: res.statusCode < 400, raw: corpo }) }
            })
        })
        req.on('error', reject)
        // 45s: /send-message pode segurar a resposta até ~25s simulando "digitando..."
        // antes de mandar de fato — o timeout precisa sobrar folga em cima disso.
        req.setTimeout(45000, () => req.destroy(new Error('Timeout ao falar com a Zaya')))
        req.write(data)
        req.end()
    })
}

// Tempo de "digitando..." antes de mandar, simulando uma pessoa real: 30 palavras/min
// (~5 caracteres por palavra), ±20% de variação, entre 3s e 30s.
function calcularDelayDigitacaoMs(texto) {
    const palavras = String(texto || '').length / 5
    const segundosBase = (palavras / 30) * 60
    const variacao = 1 + (Math.random() * 0.4 - 0.2)
    const segundos = Math.min(30, Math.max(3, segundosBase * variacao))
    return Math.round(segundos * 1000)
}

// Trava de segurança: nenhuma mensagem que mencione IA/bug/treinamento/automação pode
// sair pro cliente — quebraria a premissa de atendimento humano. A ÚNICA exceção é a
// frase de divulgação honesta que o próprio prompt instrui usar quando perguntado
// diretamente ("é um atendimento automatizado da Ziont") — tudo mais nessa linha é
// bloqueado e o Maurício é avisado pra decidir manualmente.
const FRASE_DIVULGACAO_APROVADA = 'atendimento automatizado da ziont'
const PADROES_LINGUAGEM_PROIBIDA = [/\bia\b/i, /\bbug\b/i, /treinando|treinamento/i, /automátic|automatiz/i]
function contemLinguagemProibida(texto) {
    const norm = String(texto || '').toLowerCase()
    if (norm.includes(FRASE_DIVULGACAO_APROVADA)) return false
    return PADROES_LINGUAGEM_PROIBIDA.some(re => re.test(texto || ''))
}

async function enviarMensagem(to, message) {
    if (contemLinguagemProibida(message)) {
        console.error(`🚫 [ZVendas] Mensagem BLOQUEADA (linguagem proibida): "${message}"`)
        notificarMauricio(`🚫 *ZVendas — mensagem bloqueada*\n\nUma mensagem ia ser enviada mas continha linguagem proibida (IA/bug/treinamento/automático) e foi barrada antes de sair.\n\nDestino: ${to}\nTexto: "${message}"`)
        throw new Error('Mensagem bloqueada: contém linguagem proibida (IA/bug/treinando/automático)')
    }
    const digitandoMs = calcularDelayDigitacaoMs(message)
    const r = await zayaRequest('/send-message', { to, message, digitandoMs })
    if (!r.ok) throw new Error(r.error || 'Falha ao enviar mensagem via Zaya')
    return r.jid
}

async function enviarMensagemGrupo(toGroupName, message) {
    const r = await zayaRequest('/send-message', { toGroupName, message })
    if (!r.ok) throw new Error(r.error || 'Falha ao enviar mensagem ao grupo via Zaya')
    return r.jid
}

async function enviarImagemGrupo(toGroupName, caminho, caption) {
    const r = await zayaRequest('/send-image', { toGroupName, caminho, caption })
    if (!r.ok) throw new Error(r.error || 'Falha ao enviar imagem ao grupo via Zaya')
    return r.jid
}

// Catálogo real de produtos do WhatsApp Business — carregado no boot e a cada 6h, pra
// nunca deixar o Claude inventar tipo de camiseta que não existe de verdade.
async function carregarCatalogo() {
    try {
        const r = await zayaRequest('/catalogo', {})
        if (!r.ok) throw new Error(r.error || 'falha desconhecida')
        await comMemoria(mem => {
            mem.catalogo = { atualizadoEm: new Date().toISOString(), produtos: r.produtos || [] }
        })
        console.log(`📦 [ZVendas] Catálogo carregado: ${r.produtos?.length || 0} produtos`)
    } catch (err) {
        console.error('⚠️ [ZVendas] Erro ao carregar catálogo do WhatsApp Business:', err.message)
    }
}

function agendarAtualizacaoCatalogo() {
    carregarCatalogo().catch(() => {})
    setInterval(() => carregarCatalogo().catch(() => {}), 6 * 60 * 60 * 1000)
}

async function aplicarEtiqueta(jid, nomeEtiqueta) {
    try {
        const r = await zayaRequest('/apply-label', { jid, label: nomeEtiqueta })
        if (!r.ok) throw new Error(r.error || 'falha desconhecida')
        console.log(`🏷️ [ZVendas] Etiqueta atualizada: ${jid} → ${nomeEtiqueta}`)
    } catch (err) {
        console.error(`⚠️ [ZVendas] Não consegui aplicar a etiqueta "${nomeEtiqueta}" em ${jid}: ${err.message}`)
    }
}

function notificarMauricio(mensagem) {
    zayaRequest('/zvendas-notificacao', { mensagem }).catch(err =>
        console.error('⚠️ [ZVendas] Falha ao notificar Maurício via Zaya:', err.message))
}

// ─────────────────────────────────────────────────────────────────────────────
// FASE 1 — Prospecção no Google Maps (24h, só empresas "aberto agora", ciclo progressivo)
// ─────────────────────────────────────────────────────────────────────────────

// TERMOS_BUSCA e a extração de verdade (Puppeteer) agora vivem em maps-prospeccao.js
// — mesma lógica reaproveitada pelo zmatheus.js (canal Matheus), só o profileDir do
// browser muda por canal (nunca reusar userDataDir entre browsers concorrentes).
async function buscarEmpresasNoMaps(termo, quantidade) {
    return buscarEmpresasNoMapsCompartilhado(termo, quantidade, PROFILE_DIR)
}

async function cicloProspeccao() {
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
    const { restante } = await comMemoria(mem => {
        if (mem.contadorDiario.data !== hoje) {
            mem.contadorDiario = { data: hoje, quantidade: 0, meta: aleatorioEntre(15, 25) }
        }
        return { restante: mem.contadorDiario.meta - mem.contadorDiario.quantidade }
    })
    if (restante <= 0) {
        console.log(`🔍 [ZVendas] Meta diária atingida — pulando ciclo`)
        return
    }

    const termo = TERMOS_BUSCA[Math.floor(Math.random() * TERMOS_BUSCA.length)]
    console.log(`🔍 [ZVendas] Buscando empresas em São Paulo — termo: ${termo}`)

    let encontradas = []
    try {
        // 20 (não só 8-10) de propósito — parte considerável descarta como fixo antes
        // mesmo de checar WhatsApp, precisa de matéria-prima extra pra sobrar 8-10 bons.
        encontradas = await buscarEmpresasNoMaps(termo, 20)
    } catch (err) {
        console.error('❌ [ZVendas] Erro na busca do Google Maps:', err.message)
        return
    }

    // Descarta quem já está na lista antes de gastar chamada de rede verificando WhatsApp.
    const jaContatadasAntes = await comMemoria(mem => new Set(mem.empresasContatadas.map(e => normalizarTelefone(e.telefone))))
    const candidatas = encontradas.filter(e => !jaContatadasAntes.has(normalizarTelefone(e.telefone)))

    // Só entra na fila quem realmente tem WhatsApp (via Zaya/sock.onWhatsApp) — evita
    // gastar abordagem com telefone fixo/comercial sem WhatsApp. Fixo é descartado
    // ANTES até de gastar a chamada de rede — só celular (DDD + 9 dígitos) pode ter
    // WhatsApp de verdade.
    const comWhatsapp = []
    for (const emp of candidatas) {
        if (comWhatsapp.length >= restante) break
        if (!pareceCelular(emp.telefone)) {
            console.log(`📵 [ZVendas] Número fixo ignorado: ${emp.telefone}`)
            continue
        }
        let temWhatsapp = false
        try {
            const r = await zayaRequest('/check-whatsapp', { numero: emp.telefone })
            temWhatsapp = !!r?.temWhatsapp
        } catch (err) {
            console.error(`⚠️ [ZVendas] Erro ao verificar WhatsApp de ${emp.telefone}: ${err.message}`)
        }
        console.log(`📱 [ZVendas] ${emp.telefone} — WhatsApp: ${temWhatsapp ? 'sim' : 'não'}`)
        if (temWhatsapp) comWhatsapp.push(emp)
    }

    // Só entra no lock (rápido, síncrono) depois da busca lenta no Maps/verificação de
    // WhatsApp — evita segurar a memória travada por dezenas de segundos.
    await comMemoria(mem => {
        if (mem.contadorDiario.data !== hoje) {
            mem.contadorDiario = { data: hoje, quantidade: 0, meta: aleatorioEntre(15, 25) }
        }
        const jaContatadas = new Set(mem.empresasContatadas.map(e => normalizarTelefone(e.telefone)))
        const restanteAgora = mem.contadorDiario.meta - mem.contadorDiario.quantidade
        const novas = comWhatsapp
            .filter(e => !jaContatadas.has(normalizarTelefone(e.telefone)))
            .slice(0, Math.min(aleatorioEntre(8, 10), restanteAgora))

        for (const emp of novas) {
            const canal = proximoCanal(mem)
            mem.empresasContatadas.push({
                nome: emp.nome, telefone: emp.telefone, jid: null,
                status: 'pendente', etiqueta: null, dataContato: null, termoBusca: termo,
                aguardandoResposta: false, followupsEnviados: 0, dataUltimoFollowup: null,
                canal,
            })
        }
        mem.contadorDiario.quantidade += novas.length
        console.log(`🔍 [ZVendas] ${novas.length} nova(s) empresa(s) salva(s) (termo: ${termo}, meta do dia: ${mem.contadorDiario.quantidade}/${mem.contadorDiario.meta})`)
    })
}

// Sequência de intervalos entre buscas (minutos), progressiva ao longo do dia:
// 1min, 2min, 4min, 8min, 16min, 32min, e a partir da 7ª busca fica fixo em 64min.
// Reinicia todo dia (contado por data America/Sao_Paulo). Roda 24h — cada empresa
// encontrada só entra na fila se estiver "aberto agora" no Maps no momento da busca.
const DELAYS_PROGRESSIVOS_MIN = [1, 2, 4, 8, 16, 32]

function proximoDelayBuscaMinutos(numeroBusca) {
    const idx = numeroBusca - 1
    return idx < DELAYS_PROGRESSIVOS_MIN.length ? DELAYS_PROGRESSIVOS_MIN[idx] : 64
}

async function agendarProspeccao() {
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
    const numeroBusca = await comMemoria(mem => {
        if (!mem.sequenciaBusca || mem.sequenciaBusca.data !== hoje) {
            mem.sequenciaBusca = { data: hoje, proximaBuscaNumero: 1 }
        }
        return mem.sequenciaBusca.proximaBuscaNumero
    })
    const delayMin = proximoDelayBuscaMinutos(numeroBusca)
    const jitterMs = aleatorioEntre(-30, 30) * 1000
    const esperaMs = Math.max(5000, delayMin * 60 * 1000 + jitterMs)
    console.log(`🔍 [ZVendas] Busca #${numeroBusca} em ~${delayMin}min`)

    setTimeout(async () => {
        await cicloProspeccao().catch(err => console.error('❌ [ZVendas] Erro no ciclo de prospecção:', err.message))

        await comMemoria(mem => {
            if (!mem.sequenciaBusca || mem.sequenciaBusca.data !== hoje) {
                mem.sequenciaBusca = { data: hoje, proximaBuscaNumero: 1 }
            }
            mem.sequenciaBusca.proximaBuscaNumero = numeroBusca + 1
        })

        agendarProspeccao()
    }, esperaMs)
}

// ─────────────────────────────────────────────────────────────────────────────
// FASE 2 — Abordagem inicial (2 mensagens separadas, 8-15s de intervalo, depois
// PARA e aguarda resposta — etiqueta "Novo cliente" só depois das duas)
// ─────────────────────────────────────────────────────────────────────────────

// Saudação da mensagem 1 varia pelo período do dia em horário de Brasília.
function saudacaoPorHorario() {
    const hora = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }))
    if (hora >= 5 && hora < 12) return 'Bom dia!'
    if (hora >= 12 && hora < 18) return 'Boa tarde!'
    return 'Boa noite!' // 18h-5h (agora roda 24h, ver "aberto agora" pra decidir quem abordar)
}

// Mensagem 1b, sempre logo depois da saudação (8-15s de intervalo).
const MENSAGEM_ABORDAGEM_1B = 'Tudo bem?'

// Mensagem 2 (apresentação da Ziont/pitch) NÃO é mais enviada automaticamente — só
// dispara quando o prospect responde de verdade pela 1ª vez (ver hook em
// tratarMensagemRecebida, seção FASE 2.5 abaixo).
const MENSAGEM_ABORDAGEM_2 = 'Me chamo Maurício, trabalho com a Ziont. Fazemos camiseta e uniforme personalizado. Vocês usam uniforme pra equipe?'

// ─────────────────────────────────────────────────────────────────────────────
// FASE 2.5 — Follow-up pra quem recebeu a Mensagem 1/1b (saudação) e nunca respondeu
// ─────────────────────────────────────────────────────────────────────────────
const MENSAGEM_FOLLOWUP_1 = 'Oi, tudo bem? Passando de novo, trabalho com personalizados pra empresas aqui de SP'
const MENSAGEM_FOLLOWUP_2 = 'Oi, fico à disposição se precisar de camiseta ou uniforme personalizado, qualquer coisa é só chamar'
const DIAS_FOLLOWUP_1 = 3 // dias após a Mensagem 1 (dataContato), se ainda sem resposta
const DIAS_FOLLOWUP_2 = 6 // dias após o Follow-up 1 (dataUltimoFollowup), se ainda sem resposta

async function gerarAbordagem(empresa) {
    return MENSAGEM_ABORDAGEM_2
}

async function abordarEmpresa(empresa) {
    console.log(`📱 [ZVendas] Abordando: ${empresa.nome} — ${empresa.telefone}`)

    // Duas mensagens separadas (saudação do horário + "Tudo bem?"), 8-15s de
    // intervalo — depois disso PARA e aguarda resposta de verdade. O pitch
    // (Mensagem 2/apresentação da Ziont) só sai quando a pessoa responder, ver
    // hook em tratarMensagemRecebida.
    const saudacao = saudacaoPorHorario()
    const jid = await enviarMensagem(empresa.telefone, saudacao)
    await esperar(aleatorioEntre(8, 15) * 1000)
    await enviarMensagem(jid, MENSAGEM_ABORDAGEM_1B)
    await aplicarEtiqueta(jid, ETIQUETAS.novoCliente)

    // Só grava depois de terminar todo o envio (rede) — evita segurar o lock por
    // segundos enquanto manda mensagem, mas ainda assim serializado com outras fases.
    await comMemoria(mem => {
        const idx = mem.empresasContatadas.findIndex(e => normalizarTelefone(e.telefone) === normalizarTelefone(empresa.telefone))
        if (idx >= 0) {
            mem.empresasContatadas[idx].status = 'contatado'
            mem.empresasContatadas[idx].etiqueta = ETIQUETAS.novoCliente
            mem.empresasContatadas[idx].jid = jid
            mem.empresasContatadas[idx].dataContato = new Date().toISOString()
            mem.empresasContatadas[idx].aguardandoResposta = true
        }
        // Nunca duplica conversa pra um telefone que já tem uma — mesmo que
        // abordarEmpresa seja chamado de novo pro mesmo número por engano, continua
        // na MESMA conversa (com o histórico e dadosColetados que já existiam).
        const conversaExistente = mem.conversasAtivas.find(c => normalizarTelefone(c.telefone) === normalizarTelefone(empresa.telefone))
        if (conversaExistente) {
            conversaExistente.jid = jid
            conversaExistente.historico.push(
                { de: 'zvendas', texto: saudacao, em: new Date().toISOString() },
                { de: 'zvendas', texto: MENSAGEM_ABORDAGEM_1B, em: new Date().toISOString() },
            )
            return
        }
        mem.conversasAtivas.push({
            telefone: empresa.telefone,
            jid,
            nome: null,
            empresa: empresa.nome,
            estagio: ETIQUETAS.novoCliente,
            historico: [
                { de: 'zvendas', texto: saudacao, em: new Date().toISOString() },
                { de: 'zvendas', texto: MENSAGEM_ABORDAGEM_1B, em: new Date().toISOString() },
            ],
            dadosColetados: {},
        })
    })
}

async function processarProximaAbordagem() {
    const mem = carregarMemoria()
    // canal ausente (registro de antes da divisão) = 'zaya', por compatibilidade.
    const pendente = mem.empresasContatadas.find(e => e.status === 'pendente' && (e.canal || 'zaya') === 'zaya')
    if (!pendente) return
    await abordarEmpresa(pendente)
}

function agendarAbordagens() {
    processarProximaAbordagem().catch(err => console.error('❌ [ZVendas] Erro ao abordar empresa:', err.message))
    const proximo = aleatorioEntre(15, 40) * 60 * 1000
    setTimeout(agendarAbordagens, proximo)
}

// ─────────────────────────────────────────────────────────────────────────────
// FASE 3 — Atendimento 24h (responde só quem já foi abordado e escreveu de volta)
// ─────────────────────────────────────────────────────────────────────────────

const FERRAMENTA_RESPOSTA = {
    name: 'responder_cliente',
    description: 'Gera a resposta a enviar ao cliente e classifica o estágio atual da conversa de venda.',
    input_schema: {
        type: 'object',
        properties: {
            mensagens: {
                type: 'array',
                items: { type: 'string' },
                minItems: 0,
                maxItems: 4,
                description: 'Uma ou mais mensagens curtas a enviar ao cliente agora, cada uma no máximo 1-2 linhas, como bolhas separadas de WhatsApp (nunca uma mensagem só longa). Se precisar passar mais de uma informação, quebre em vários itens do array em vez de juntar tudo numa mensagem só. Deixe vazio (array []) quando naoCompreendido=true.',
            },
            naoCompreendido: {
                type: 'boolean',
                description: 'true quando a mensagem do cliente for uma pergunta estranha, um assunto totalmente fora do contexto de venda de camisetas/uniformes personalizados, ou uma situação não prevista em nenhuma regra acima — ou seja, você NÃO sabe responder com segurança. Quando true: deixe "mensagens" vazio (nenhuma resposta será enviada, a conversa fica marcada como não lida pra revisão manual do Maurício) e ignore os outros campos (preencha com valores neutros: etiqueta null, pedidoConfirmado/descontoSolicitado false, percentualDesconto null, dadosColetados com os campos que já tinha antes). Use com moderação — só pra casos realmente fora do escopo, nunca pra perguntas normais de venda que você sabe responder.',
            },
            etiqueta: {
                type: ['string', 'null'],
                enum: [ETIQUETAS.emAndamento, ETIQUETAS.propostaEnviada, ETIQUETAS.cliente, ETIQUETAS.naoInteressado, ETIQUETAS.seguirDepois, null],
                description: `Nova etiqueta do contato SE o estágio mudou nesta mensagem (ex: cliente demonstrou interesse pela primeira vez, você acabou de enviar uma proposta/preço, o cliente disse que não quer, ou pediu pra falar depois). null se não mudou. IMPORTANTE: "${ETIQUETAS.cliente}" só pode ser usado JUNTO com pedidoConfirmado=true — uma resposta positiva tipo "podemos sim"/"beleza"/"tá bom" NÃO é fechamento de pedido, é só continuar a conversa (normalmente fica "${ETIQUETAS.emAndamento}" ou null).`,
            },
            pedidoConfirmado: { type: 'boolean', description: 'true quando o cliente confirmou explicitamente que quer fechar o pedido NESTA mensagem (ex: "fechado", "pode fazer", "confirmado", "vamos nessa") E você já sabe produto/tipo e quantidade (nome e empresa podem ser preenchidos nesta própria mensagem). NÃO espere o pagamento acontecer — o pedido é registrado como "aguardando pagamento", o Pix só é cobrado depois. Se já dá pra marcar true, marque — não adie pra uma mensagem futura só porque ainda não mandou a chave Pix ou pediu a arte.' },
            descontoSolicitado: { type: 'boolean', description: 'true se o cliente pediu desconto nesta mensagem.' },
            percentualDesconto: { type: ['number', 'null'], description: 'Percentual de desconto pedido pelo cliente, se ele mencionou um número. null se não mencionou.' },
            dadosColetados: {
                type: 'object',
                description: 'Dados do pedido coletados até agora (mescle com o que já foi dito antes na conversa, não esqueça informação já dada).',
                properties: {
                    nomeCliente: { type: ['string', 'null'] },
                    empresa: { type: ['string', 'null'] },
                    quantidade: { type: ['number', 'null'] },
                    tipoProduto: { type: ['string', 'null'] },
                    arteRecebida: { type: 'boolean' },
                    posicionamento: { type: ['string', 'null'], description: 'Onde vai a estampa: peito esquerdo, frente toda, costas ou manga. null se ainda não perguntado/respondido.' },
                },
                required: ['nomeCliente', 'empresa', 'quantidade', 'tipoProduto', 'arteRecebida', 'posicionamento'],
            },
        },
        required: ['mensagens', 'naoCompreendido', 'etiqueta', 'pedidoConfirmado', 'descontoSolicitado', 'percentualDesconto', 'dadosColetados'],
    },
}

function montarSecaoCatalogo() {
    const { produtos } = carregarMemoria().catalogo || { produtos: [] }
    if (!produtos.length) {
        return `CATÁLOGO: ainda não carregado. NÃO invente nomes de produto/tipo de camiseta — se o cliente perguntar o que vocês têm, diga que já já confirma as opções certinho (sem citar tipos específicos) e passe pro próximo passo (quantidade/uso).`
    }
    const lista = produtos.map(p => `- ${p.nome}${p.preco ? ` (R$ ${p.preco.toFixed(2)})` : ''}${p.descricao ? ` — ${p.descricao}` : ''}`).join('\n')
    return `CATÁLOGO REAL (os ÚNICOS produtos que existem — NUNCA cite tipo de camiseta que não esteja nesta lista):\n${lista}`
}

function montarSecaoCores() {
    const coresPorProduto = carregarMemoria().coresPorProduto || {}
    const entradas = Object.entries(coresPorProduto)
    if (!entradas.length) return ''
    const lista = entradas.map(([produto, cores]) => `- ${produto}: ${cores.join(', ')}`).join('\n')
    return `\nCORES DISPONÍVEIS POR PRODUTO (só existem essas — se o cliente pedir uma cor que não está na lista do produto dele, informe com simpatia que essa cor não tem e ofereça as opções reais que existem, sem inventar nem confirmar cor inexistente):\n${lista}\n`
}

function montarSystemPrompt(linkAvaliacoes) {
    return `Você é um vendedor da Ziont, empresa especializada em camisetas personalizadas e uniformes corporativos em São Paulo, conversando pelo WhatsApp.

${montarSecaoCatalogo()}
${montarSecaoCores()}

COMO ESCREVER (muito importante):
- Escreva como uma pessoa real digitando no celular, não como um atendimento formal de empresa.
- Cada mensagem: 1 frase, no máximo 2 quando for muito necessário. Nunca parágrafos longos.
- Evite frases com cara de script tipo "Podemos conversar sobre?" — prefira perguntas diretas relacionadas ao negócio específico da empresa (ex: "Vocês usam uniforme pra equipe?" em vez de algo genérico).
- Se precisar passar mais de uma informação, quebre em várias mensagens curtas (array "mensagens") em vez de uma mensagem grande — é assim que gente de verdade manda WhatsApp, em várias bolhas.
- No máximo UMA pergunta por mensagem. Nunca empilhe duas ou três perguntas na mesma bolha (ex: nunca "quantas peças, qual cor e qual o prazo?" tudo junto) — pergunte uma coisa, espere a resposta, depois pergunta a próxima.
- Nada de listas numeradas, tópicos, bullet points ou menu de opções (1-x, 2-y...) — isso é jeito de bot, não de pessoa.
- No máximo 1 emoji por mensagem, e só quando fizer sentido — não use emoji em toda mensagem.
- Direto e simples, sem formalidade excessiva ("Prezado", "Fico à disposição", etc.).

NUNCA REPETIR (muito importante): antes de perguntar qualquer coisa, releia TODO o histórico da conversa acima E os dados já coletados. Se quantidade, tipo de camiseta, nome ou empresa já foram ditos em qualquer mensagem anterior do cliente, NÃO pergunte de novo — use o que já foi dito e avance pro próximo passo que falta (fluxo: quantidade+tipo → arte/logo → dados finais → confirmar pedido). Perguntar de novo algo que o cliente já respondeu é o pior erro possível aqui.

FLUXO DE VENDA:
1. Quando o cliente demonstrar interesse: entenda o que ele precisa (quantidade, tipo de camiseta, uso).
2. Ofereça o produto certo com base na necessidade — usando SOMENTE os produtos do CATÁLOGO REAL acima.
3. Prazo de entrega: 5 dias úteis.
4. Não há pedido mínimo — qualquer quantidade.
5. Quando o cliente confirmar que quer fechar (mesmo que o pagamento ainda não tenha sido feito — o pedido entra como "aguardando pagamento"): colete nome, empresa, quantidade e tipo de camiseta, e marque pedidoConfirmado=true nessa mesma resposta.
6. Peça a arte/logo pelo próprio WhatsApp.
6b. Assim que a arte chegar (arteRecebida=true), pergunte o posicionamento em UMA ÚNICA mensagem já com as opções resumidas — nunca pergunte isso em várias mensagens separadas. Exemplo exato do formato: "Recebi! 👍 Onde você quer a estampa? Peito esquerdo, frente toda, costas ou manga?". Essa regra (uma mensagem só, com as opções já embutidas) vale pra qualquer pergunta de múltipla escolha parecida, não só posicionamento.
6c. Com quantidade + tipo + arte + posicionamento todos coletados, avance: informe o valor total (se souber) e confirme o pedido.
7. Pagamento é 100% adiantado via Pix (chave: ${PIX_ZIONT}).${SHOPEE_LINK ? `\n   Se fizer sentido, também pode indicar o catálogo: ${SHOPEE_LINK}` : ''}
8. Se o cliente pedir desconto: a única mensagem sobre isso é exatamente "deixa eu verificar aqui pra você 😊" (nada além disso) e marque descontoSolicitado=true — você NUNCA aprova ou nega desconto sozinho, quem decide é o Maurício.

Se o cliente perguntar diretamente se está falando com um robô, IA ou automação, responda com honestidade que é um atendimento automatizado da Ziont — nunca negue isso nem finja ser uma pessoa quando perguntado diretamente.

CONFIANÇA — quando o cliente desconfiar da empresa (ex: "é golpe?", "é confiável?", "como sei que é verdade?", "não conheço vocês", "nunca ouvi falar", "tem como comprovar?", "tem avaliações?", "parece suspeito", "não sei se confio", ou qualquer variação de dúvida sobre a legitimidade), responda em 2-3 mensagens curtas separadas nessa ordem:
1. Tranquilizar de forma natural: algo como "Entendo a desconfiança, é importante mesmo! 😊"
2. ${linkAvaliacoes ? `Mostrar prova social: "Dá uma olhada nas nossas avaliações: ${linkAvaliacoes}"` : `(não tem link de avaliações disponível agora — pule direto pra mensagem 3, não invente link nem prometa mandar depois)`}
3. Reforçar segurança do processo: algo como "Trabalhamos com confirmação da arte antes da produção 🎨" (só manda essa se ele ainda parecer inseguro depois da 1-2)

NÃO SEI RESPONDER — se a mensagem do cliente for uma pergunta estranha, um assunto totalmente fora do contexto de venda de camisetas/uniformes (ex: pedir ajuda com outra coisa, reclamar de um assunto sem relação, qualquer situação que não se encaixe em nenhuma regra acima), marque naoCompreendido=true e deixe "mensagens" vazio — NÃO tente adivinhar uma resposta nem force um encaixe forçado no fluxo de venda. Use isso raramente, só quando você realmente não souber o que fazer.

Use SEMPRE a ferramenta responder_cliente pra responder.`
}

// A API da Claude exige alternância estrita user/assistant — como agora uma resposta
// do ZVendas pode virar várias mensagens seguidas no histórico (mesma role), agrupa
// mensagens consecutivas da mesma role num único turno antes de enviar.
function agruparPorTurno(historico) {
    const turnos = []
    for (const h of historico) {
        const role = h.de === 'cliente' ? 'user' : 'assistant'
        const ultimo = turnos[turnos.length - 1]
        if (ultimo && ultimo.role === role) {
            ultimo.content += '\n' + h.texto
        } else {
            turnos.push({ role, content: h.texto })
        }
    }
    return turnos
}

// Checagem extra só na 1ª resposta de cada número — bots sofisticados escrevem natural
// o bastante pra passar pelos padrões de regex (ex: "sou a Lari, atendimento virtual...").
async function classificarHumanoOuBot(texto) {
    try {
        const resp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 10,
            messages: [{ role: 'user', content: `Essa mensagem foi enviada por um humano ou é um bot automático? Responda apenas "humano" ou "bot".\n\nMensagem: "${texto}"` }],
        })
        const resposta = (resp.content.find(b => b.type === 'text')?.text || '').trim().toLowerCase()
        return resposta.includes('bot') ? 'bot' : 'humano'
    } catch (err) {
        console.error('⚠️ [ZVendas] Erro ao classificar humano/bot via Claude:', err.message)
        return 'humano' // falha técnica não deve bloquear um lead de verdade
    }
}

async function chamarClaudeVendedor(historico) {
    const mensagensClaude = agruparPorTurno(historico)
    const linkAvaliacoes = await obterLinkAvaliacoes()
    const resp = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: montarSystemPrompt(linkAvaliacoes),
        messages: mensagensClaude,
        tools: [FERRAMENTA_RESPOSTA],
        tool_choice: { type: 'tool', name: 'responder_cliente' },
    })
    const toolUse = resp.content.find(b => b.type === 'tool_use')
    return toolUse?.input || null
}

function proximoDiaUtil(data) {
    const d = new Date(data)
    d.setDate(d.getDate() + 1)
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
    return d
}

function somarDiasUteis(dataBase, dias) {
    let d = new Date(dataBase)
    let restantes = dias
    while (restantes > 0) {
        d = proximoDiaUtil(d)
        restantes--
    }
    return d
}

function formatarDataBR(d) {
    return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
}

// Detecta resposta de bot/menu automático de atendimento da empresa contatada (não é
// um cliente de verdade respondendo) — nesse caso não vale a pena (nem faz sentido)
// o Claude tentar conduzir uma venda contra um menu automatizado.
const PADROES_BOT = [
    /selecione\s+uma\s+op[çc][ãa]o/i,
    /clique\s+no\s+bot[ãa]o/i,
    /op[çc][ãa]o\s+inv[áa]lida/i,
    /(seja\s+)?bem[\s-]?vindo\(?a?\)?\s+(a|à|ao)\s/i,
    /para\s+encerrar\s*,?\s*digite\s+sair/i,
    /digite\s+uma\s+das\s+op[çc][õo]es/i,
    /para\s+come[çc]ar,?\s+qual\s+categoria/i,
    /\b(novos?|seminovos?)\s*\/\s*(novos?|seminovos?)\b/i,
    /\bcontinuar\s*\/\s*encerrar\b/i,
    /\batendente\s*\/\s*encerrar\b/i,
    /digite\s+o\s+n[úu]mero\s+da\s+op[çc][ãa]o/i,
    /\b\d\s*[-–)]\s*\w+.*\n.*\d\s*[-–)]\s*\w+/i, // duas linhas seguidas em formato "1 - opção" / "2 - opção" (menu numerado)
    /desculpe,?\s*n[ãa]o\s+entendi/i,
    /^\s*qual\s+categoria\b/i,
    /para\s+come[çc]ar\b/i,
    /sou\s+um\s+atendimento\s+virtual/i,
    /assistente\s+virtual/i,
    /\bchatbot\b/i,
    /rob[ôo]\s+de\s+atendimento/i,
    /atendimento\s+autom[áa]tico/i,
    /fora\s+do\s+hor[áa]rio\s+comercial,?\s+sou\s+um/i,
    /\b(sou|somos)\s+um\s+(bot|robô|assistente|atendimento)\s+(virtual|autom[áa]tico)\b/i,
]
function pareceRespostaDeBot(texto) {
    return PADROES_BOT.some(re => re.test(texto || ''))
}

// Pedido de catálogo/produtos — resolvido de forma determinística (manda o link real
// do catálogo do WhatsApp Business), não deixa o Claude tentar listar produto de cabeça.
const PADROES_PEDIDO_CATALOGO = [
    /cat[áa]logo/i,
    /\bprodutos?\b/i,
    /o\s+que\s+voc[êe]s?\s+(t[êe]m|faz[eê]m|vend[eê]m|oferece[m]?)/i,
    /quais\s+camisetas?/i,
    /\bpre[çc]os?\b/i,
]
function pareceQuererCatalogo(texto) {
    return PADROES_PEDIDO_CATALOGO.some(re => re.test(texto || ''))
}

let linkCatalogoCache = null
let linkAvaliacoesCache = { valor: undefined, em: 0 }
// Link pra mandar quando o cliente desconfiar da empresa — tenta a URL de um produto real
// do catálogo (cada produto pode ter um link cadastrado, ex: pra Shopee) e cai pro
// SHOPEE_LINK do .env se o catálogo não tiver nada. Cacheado 10min (catálogo é lento).
async function obterLinkAvaliacoes() {
    if (linkAvaliacoesCache.valor !== undefined && Date.now() - linkAvaliacoesCache.em < 10 * 60 * 1000) {
        return linkAvaliacoesCache.valor
    }
    let link = SHOPEE_LINK || null
    try {
        const r = await zayaRequest('/catalogo', {})
        const comUrl = r.ok ? r.produtos?.find(p => p.url) : null
        if (comUrl) link = comUrl.url
    } catch (err) {
        console.error('⚠️ [ZVendas] Erro ao buscar link de avaliações no catálogo:', err.message)
    }
    linkAvaliacoesCache = { valor: link, em: Date.now() }
    return link
}

async function obterLinkCatalogo() {
    if (linkCatalogoCache) return linkCatalogoCache
    try {
        const r = await zayaRequest('/meu-numero', {})
        if (!r.ok || !r.numero) throw new Error(r.error || 'número não disponível')
        linkCatalogoCache = `https://wa.me/c/${r.numero}`
        return linkCatalogoCache
    } catch (err) {
        console.error('⚠️ [ZVendas] Erro ao obter link do catálogo:', err.message)
        return null
    }
}

async function enviarProduto(to, produto) {
    const r = await zayaRequest('/send-product', { to, produto })
    if (!r.ok) throw new Error(r.error || 'Falha ao enviar produto via Zaya')
    return r.jid
}

// Manda cada produto do catálogo como mensagem de produto de verdade (igual "+" →
// Catálogo → selecionar produto no WhatsApp Business), não texto nem link. Se o
// catálogo não responder, cai pro link como alternativa (nunca fica sem responder).
async function enviarCatalogoNaConversa(jid) {
    await enviarMensagem(jid, 'A gente faz camiseta personalizada e uniforme corporativo, dá uma olhada no catálogo 👇')
    const r = await zayaRequest('/catalogo', {})
    if (!r.ok || !r.produtos?.length) {
        console.error('⚠️ [ZVendas] Catálogo indisponível, caindo pro link:', r.error || 'sem produtos')
        const link = await obterLinkCatalogo()
        await enviarMensagem(jid, link ? `Aqui está nosso catálogo! 📦 ${link}` : `Já já te mando o catálogo certinho, só um instante 🙂`)
        return
    }
    for (const produto of r.produtos) {
        try {
            await enviarProduto(jid, produto)
        } catch (err) {
            console.error(`⚠️ [ZVendas] Erro ao enviar produto "${produto.nome}":`, err.message)
        }
    }
    await enviarMensagem(jid, 'Qual desses te interessou? 😊')
}

function registrarPedidoFechado(mem, conversa) {
    mem.contadorPedidos = (mem.contadorPedidos || 0) + 1
    const numero = String(mem.contadorPedidos).padStart(3, '0')
    const dataEntrega = formatarDataBR(somarDiasUteis(new Date(), 5))
    const dados = conversa.dadosColetados || {}
    const pedido = {
        numero,
        cliente: conversa.nome || '(não informado)',
        empresa: conversa.empresa || '(não informado)',
        quantidade: dados.quantidade ?? null,
        tipo: dados.tipoProduto || '(não informado)',
        arte: dados.arteRecebida ? 'Recebida' : 'Aguardando',
        arteCaminho: dados.arteCaminho || null,
        posicionamento: dados.posicionamento || null,
        valor: null,
        dataEntrega,
        status: 'fechado',
        contato: conversa.telefone,
        criadoEm: new Date().toISOString(),
    }
    mem.pedidosFechados.push(pedido)
    conversa.estagio = ETIQUETAS.cliente
    const emp = mem.empresasContatadas.find(e => normalizarTelefone(e.telefone) === normalizarTelefone(conversa.telefone))
    if (emp) emp.etiqueta = ETIQUETAS.cliente
    return pedido
}

function formatarMensagemGrupoPedido(pedido) {
    const valorFmt = pedido.valor != null ? `R$ ${Number(pedido.valor).toFixed(2).replace('.', ',')}` : '(a definir)'
    const linhas = [
        `🛍️ *PEDIDO #${pedido.numero}*`,
        ``,
        `👤 ${pedido.cliente}`,
        `📦 ${pedido.tipo}`,
        `📏 Quantidade: ${pedido.quantidade ?? '?'}`,
    ]
    if (pedido.arte === 'Recebida') {
        linhas.push(`🎨 Posicionamento: ${pedido.posicionamento || '(não informado)'}`)
    } else {
        linhas.push(`⚠️ Arte: não recebida — solicitar ao cliente`)
    }
    linhas.push(
        `💰 Pix: ${valorFmt} — aguardando`,
        `📅 Entrega: ${pedido.dataEntrega}`,
        `📱 ${pedido.contato}`,
    )
    return linhas.join('\n')
}

async function anunciarPedidoFechado(jid, pedido) {
    // Manda a arte ANTES da mensagem de texto do pedido, como uma pessoa faria.
    if (pedido.arteCaminho) {
        try {
            await enviarImagemGrupo('Zark e Ziont | Produção', pedido.arteCaminho)
        } catch (err) {
            console.error('❌ [ZVendas] Erro ao postar a arte no grupo Zark e Ziont | Produção:', err.message)
        }
    }
    try {
        await enviarMensagemGrupo('Zark e Ziont | Produção', formatarMensagemGrupoPedido(pedido))
    } catch (err) {
        console.error('❌ [ZVendas] Erro ao postar pedido no grupo Zark e Ziont | Produção:', err.message)
    }
    notificarMauricio(`💰 *ZVendas — pedido fechado #${pedido.numero}*\n\n${pedido.cliente} (${pedido.empresa}) — ${pedido.tipo} x${pedido.quantidade ?? '?'}\nEntrega: ${pedido.dataEntrega}`)
    console.log(`💰 [ZVendas] Pedido fechado #${pedido.numero}: ${pedido.cliente} — ${pedido.quantidade ?? '?'} peças`)
    await aplicarEtiqueta(jid, ETIQUETAS.cliente)
}

async function tratarMensagemRecebida(from, text, pushName, ehInterativo, temMidia, arteCaminho, downloadFalhou, audioTranscricaoFalhou, key, messageTimestamp) {
    // Registra a mensagem e decide o que fazer tudo dentro do lock — evita perder a
    // etiqueta/estágio numa corrida com a Fase 1/2 rodando em paralelo.
    const decisao = await comMemoria(mem => {
        const conversa = mem.conversasAtivas.find(c => c.jid === from || normalizarTelefone(c.telefone) === normalizarTelefone(from))
        if (!conversa) return { ignorar: true } // não é lead do ZVendas (ex: funcionário falando com a Zaya)

        const ultimaAntes = conversa.historico[conversa.historico.length - 1]
        const agora = new Date()
        conversa.historico.push({ de: 'cliente', texto: text, em: agora.toISOString() })
        // Guardado pra poder marcar essa mensagem como não lida depois (POST
        // /mark-unread), se o Claude não conseguir mapear a resposta pra nenhuma
        // ação clara (ver gerarEEnviarRespostaClaude) — sock.chatModify exige a
        // referência exata da última mensagem recebida, não dá pra reconstruir depois.
        if (key && messageTimestamp) conversa.ultimaMensagemRecebida = { key, messageTimestamp }

        // Resposta em menos de 3s depois da NOSSA mensagem é rápido demais pra ser uma
        // pessoa lendo e digitando — sinal forte de menu automático de atendimento.
        if (conversa.estagio !== ETIQUETAS.naoInteressado && ultimaAntes?.de === 'zvendas') {
            const deltaMs = agora.getTime() - new Date(ultimaAntes.em).getTime()
            if (deltaMs >= 0 && deltaMs < 3000) {
                conversa.estagio = ETIQUETAS.naoInteressado
                const emp = mem.empresasContatadas.find(e => normalizarTelefone(e.telefone) === normalizarTelefone(conversa.telefone))
                if (emp) emp.etiqueta = ETIQUETAS.naoInteressado
                return { bot: true, viaTempo: true, jid: conversa.jid, telefone: conversa.telefone, nome: conversa.nome || conversa.empresa || from }
            }
        }

        // Imagem/documento recebido — marca arteRecebida direto, não depende do Claude
        // interpretar isso certo a partir do placeholder de texto "[imagem recebida]".
        // Se o download falhou do lado da Zaya, não marca — a arte não chegou de verdade.
        if (temMidia && !downloadFalhou) {
            conversa.dadosColetados = conversa.dadosColetados || {}
            conversa.dadosColetados.arteRecebida = true
            if (arteCaminho) conversa.dadosColetados.arteCaminho = arteCaminho
        }

        if (conversa.estagio === ETIQUETAS.naoInteressado) return { ignorar: true } // já identificado como bot antes — nunca mais tenta

        // Botão/lista interativa (buttonsMessage/listMessage) já é sinal direto de bot,
        // sem nem precisar checar o texto contra os padrões.
        if (ehInterativo || pareceRespostaDeBot(text)) {
            conversa.estagio = ETIQUETAS.naoInteressado
            const emp = mem.empresasContatadas.find(e => normalizarTelefone(e.telefone) === normalizarTelefone(conversa.telefone))
            if (emp) emp.etiqueta = ETIQUETAS.naoInteressado
            return { bot: true, jid: conversa.jid, telefone: conversa.telefone, nome: conversa.nome || conversa.empresa || from }
        }

        const respostasCliente = conversa.historico.filter(h => h.de === 'cliente').length
        return { seguir: true, jid: conversa.jid, telefone: conversa.telefone, nome: conversa.nome || conversa.empresa || from, ehPrimeiraResposta: respostasCliente === 1 }
    })

    if (decisao.ignorar) return

    if (decisao.bot) {
        console.log(decisao.viaTempo
            ? `🤖 [ZVendas] Bot detectado via etiqueta: ${decisao.telefone} → movendo para Não interessado`
            : `🤖 [ZVendas] Bot detectado: ${decisao.telefone} — bloqueado permanentemente`)
        await aplicarEtiqueta(decisao.jid, ETIQUETAS.naoInteressado)
        return
    }

    // Só na 1ª resposta de cada número — checagem extra via Claude pra pegar bots
    // sofisticados que escrevem natural o bastante pra passar pelos padrões de regex.
    if (decisao.ehPrimeiraResposta) {
        const veredito = await classificarHumanoOuBot(text)
        if (veredito === 'bot') {
            console.log(`🤖 [ZVendas] Bot detectado (classificação Claude): ${decisao.telefone} — bloqueado permanentemente`)
            await comMemoria(mem => {
                const conversa = mem.conversasAtivas.find(c => c.jid === decisao.jid)
                if (conversa) conversa.estagio = ETIQUETAS.naoInteressado
                const emp = mem.empresasContatadas.find(e => normalizarTelefone(e.telefone) === normalizarTelefone(decisao.telefone))
                if (emp) emp.etiqueta = ETIQUETAS.naoInteressado
            })
            await aplicarEtiqueta(decisao.jid, ETIQUETAS.naoInteressado)
            return
        }

        // Passou pelo classificador — é a 1ª resposta de verdade a Mensagem 1. A
        // Mensagem 2 (pitch) ficou pendente desde a Fase 2; dispara ela agora, de
        // forma determinística (não é o Claude que escreve), e sai — não cai no
        // catálogo/Claude nesta mensagem. A PRÓXIMA resposta desse telefone já não é
        // mais "primeira resposta" e segue o fluxo normal (Fase 3) automaticamente.
        // É assim que "responder a qualquer momento sai da sequência de follow-up"
        // funciona, sem precisar de código extra na Fase 2.5.
        console.log(`💬 [ZVendas] 1ª resposta de ${decisao.nome} — enviando Mensagem 2 (pitch)`)
        try {
            await enviarMensagem(decisao.jid, MENSAGEM_ABORDAGEM_2)
            await comMemoria(mem => {
                const conversa = mem.conversasAtivas.find(c => c.jid === decisao.jid)
                if (conversa) conversa.historico.push({ de: 'zvendas', texto: MENSAGEM_ABORDAGEM_2, em: new Date().toISOString() })
                const emp = mem.empresasContatadas.find(e => normalizarTelefone(e.telefone) === normalizarTelefone(decisao.telefone))
                if (emp) emp.aguardandoResposta = false
            })
        } catch (err) {
            console.error('❌ [ZVendas] Erro ao enviar Mensagem 2 (pitch):', err.message)
        }
        return
    }

    // Falha técnica no recebimento (download de imagem ou transcrição de áudio) — resposta
    // fixa e determinística, nunca escrita pelo Claude, pra nunca soar técnica/robótica.
    if (downloadFalhou || audioTranscricaoFalhou) {
        const mensagemFalha = audioTranscricaoFalhou
            ? 'Não consegui ouvir direito aqui, você consegue mandar por texto?'
            : 'Ih, acho que essa imagem não chegou direito aqui, você pode mandar de novo?'
        console.log(audioTranscricaoFalhou
            ? `🎤 [ZVendas] Transcrição de áudio falhou para ${decisao.nome} — pedindo texto`
            : `⚠️ [ZVendas] Download de imagem falhou para ${decisao.nome} — pedindo reenvio`)
        try {
            await enviarMensagem(decisao.jid, mensagemFalha)
            await comMemoria(mem => {
                const conversa = mem.conversasAtivas.find(c => c.jid === decisao.jid)
                if (conversa) conversa.historico.push({ de: 'zvendas', texto: mensagemFalha, em: new Date().toISOString() })
            })
        } catch (err) {
            console.error('❌ [ZVendas] Erro ao enviar mensagem de falha de recebimento:', err.message)
        }
        return
    }

    console.log(`💬 [ZVendas] Cliente respondeu: ${decisao.nome}`)

    // Nunca responde instantaneamente — o delay "pensando" some, agora é só o tempo de
    // digitação real (calcularDelayDigitacaoMs, 3-30s, com indicador "digitando...")
    // aplicado antes de cada mensagem via enviarMensagem.

    // Pedido de catálogo/produto/preço — resolvido na hora com o link real, sem passar
    // pelo Claude (evita ele inventar/listar produto de cabeça).
    if (pareceQuererCatalogo(text)) {
        try {
            await enviarCatalogoNaConversa(decisao.jid)
            await comMemoria(mem => {
                const conversa = mem.conversasAtivas.find(c => c.jid === decisao.jid)
                if (conversa) conversa.historico.push({ de: 'zvendas', texto: '[catálogo de produtos enviado]', em: new Date().toISOString() })
            })
            console.log(`📦 [ZVendas] Catálogo enviado: ${decisao.nome}`)
        } catch (err) {
            console.error('❌ [ZVendas] Erro ao enviar catálogo:', err.message)
        }
        return
    }

    agendarProcessamentoComDebounce(decisao.jid, decisao.nome)
}

// Se o cliente manda várias mensagens/imagens em sequência rápida (ex: 3 fotos de
// referência seguidas), cada uma chega como um evento separado — sem isso, cada uma
// disparava sua PRÓPRIA chamada ao Claude, gerando várias confirmações diferentes e
// inconsistentes ("Recebi as imagens!", "Opa, recebi a imagem!"...). O debounce junta
// tudo que chegar numa janela curta e processa como UM turno só, lendo o histórico
// (que já tem todas as mensagens/imagens daquela rajada) de uma vez.
const debounceProcessamento = new Map() // jid -> timeoutId
const DEBOUNCE_PROCESSAMENTO_MS = 4000

function agendarProcessamentoComDebounce(jid, nome) {
    if (debounceProcessamento.has(jid)) {
        clearTimeout(debounceProcessamento.get(jid))
    }
    const timeoutId = setTimeout(() => {
        debounceProcessamento.delete(jid)
        gerarEEnviarRespostaClaude(jid, nome).catch(err => console.error('❌ [ZVendas] Erro ao gerar resposta (debounce):', err.message))
    }, DEBOUNCE_PROCESSAMENTO_MS)
    debounceProcessamento.set(jid, timeoutId)
}

// Chama o Claude com o histórico atual da conversa, aplica dedup, manda as mensagens,
// atualiza etiqueta/dadosColetados/desconto/pedido. Compartilhado entre o fluxo normal
// (tratarMensagemRecebida) e a verificação periódica de clientes sem resposta.
async function gerarEEnviarRespostaClaude(jid, nome) {
    const historicoAtual = await comMemoria(mem => {
        const conversa = mem.conversasAtivas.find(c => c.jid === jid)
        return conversa ? conversa.historico.slice(-10) : null
    })
    if (!historicoAtual) return

    let resultado
    try {
        resultado = await chamarClaudeVendedor(historicoAtual)
    } catch (err) {
        console.error('❌ [ZVendas] Erro ao chamar Claude:', err.message)
        return
    }
    if (!resultado) return

    // Não conseguiu mapear a mensagem do cliente pra nenhuma ação clara — não manda
    // nada errado, só marca a conversa como não lida pra revisão manual (via Zaya,
    // que segura a sessão de verdade) usando a referência da última mensagem recebida
    // (guardada em tratarMensagemRecebida). Sem essa referência (conversa antiga, de
    // antes desse campo existir), só loga — não tem como marcar não lida sem ela.
    if (resultado.naoCompreendido) {
        const info = await comMemoria(mem => {
            const conversa = mem.conversasAtivas.find(c => c.jid === jid)
            return conversa ? { telefone: conversa.telefone, ultimaMensagemRecebida: conversa.ultimaMensagemRecebida || null } : null
        })
        console.log(`⚠️ [ZVendas] Mensagem não compreendida de ${info?.telefone || jid} — marcada como não lida para revisão manual`)
        if (info?.ultimaMensagemRecebida) {
            try {
                const r = await zayaRequest('/mark-unread', { jid, key: info.ultimaMensagemRecebida.key, messageTimestamp: info.ultimaMensagemRecebida.messageTimestamp })
                if (!r.ok) throw new Error(r.error || 'falha desconhecida')
            } catch (err) {
                console.error(`⚠️ [ZVendas] Erro ao marcar ${jid} como não lida:`, err.message)
            }
        }
        return
    }

    // Segurança de código, não só de prompt: "Cliente" só é uma etiqueta válida quando o
    // pedido foi realmente confirmado nesta mensagem — evita o modelo marcar fechamento
    // cedo demais só porque o cliente respondeu algo positivo tipo "podemos sim".
    if (resultado.etiqueta === ETIQUETAS.cliente && !resultado.pedidoConfirmado) {
        console.log(`⚠️ [ZVendas] Claude marcou etiqueta "Cliente" sem pedidoConfirmado — corrigindo pra "${ETIQUETAS.emAndamento}"`)
        resultado.etiqueta = ETIQUETAS.emAndamento
    }

    const candidatas = Array.isArray(resultado.mensagens) && resultado.mensagens.length ? resultado.mensagens : [resultado.resposta].filter(Boolean)

    // Dedup: nunca reenvia uma mensagem idêntica a alguma das últimas já mandadas nessa
    // conversa. Compara contra um CONJUNTO das últimas mensagens "zvendas" recentes (não
    // só a última) — um PAR de mensagens repetido (A+B de novo depois de A+B) não é pego
    // comparando só com "a mensagem anterior", já que A não bate com B nem vice-versa.
    const recentesZvendas = new Set(
        historicoAtual.filter(h => h.de === 'zvendas').slice(-6).map(h => h.texto.trim().toLowerCase())
    )
    const mensagens = []
    for (const texto of candidatas) {
        const norm = (texto || '').trim().toLowerCase()
        if (norm && (recentesZvendas.has(norm) || mensagens.some(m => m.trim().toLowerCase() === norm))) {
            console.log(`🔁 [ZVendas] Mensagem repetida detectada, não reenviando: "${texto}"`)
            continue
        }
        mensagens.push(texto)
    }

    for (const texto of mensagens) {
        try {
            await enviarMensagem(jid, texto)
        } catch (err) {
            console.error('❌ [ZVendas] Erro ao enviar resposta ao cliente:', err.message)
        }
    }
    if (resultado.etiqueta) {
        await aplicarEtiqueta(jid, resultado.etiqueta)
        console.log(`🏷️ [ZVendas] Etiqueta atualizada: ${nome} → ${resultado.etiqueta}`)
    }

    let desconto = null
    let pedido = null
    await comMemoria(mem => {
        const conversa = mem.conversasAtivas.find(c => c.jid === jid)
        if (!conversa) return

        conversa.dadosColetados = conversa.dadosColetados || {}
        for (const [k, v] of Object.entries(resultado.dadosColetados || {})) {
            if (ehValorColetadoValido(v)) conversa.dadosColetados[k] = v
        }
        if (ehValorColetadoValido(resultado.dadosColetados?.nomeCliente)) conversa.nome = resultado.dadosColetados.nomeCliente
        if (ehValorColetadoValido(resultado.dadosColetados?.empresa)) conversa.empresa = resultado.dadosColetados.empresa
        for (const texto of mensagens) {
            conversa.historico.push({ de: 'zvendas', texto, em: new Date().toISOString() })
        }

        if (resultado.etiqueta) {
            conversa.estagio = resultado.etiqueta
            const emp = mem.empresasContatadas.find(e => normalizarTelefone(e.telefone) === normalizarTelefone(conversa.telefone))
            if (emp) emp.etiqueta = resultado.etiqueta
        }

        if (resultado.descontoSolicitado) {
            const idDecisao = `zv_${Date.now()}`
            desconto = {
                idDecisao,
                telefone: conversa.telefone,
                jid: conversa.jid,
                cliente: conversa.nome || conversa.empresa || conversa.telefone,
                pedido: `${conversa.dadosColetados.quantidade ?? '?'} ${conversa.dadosColetados.tipoProduto || 'camiseta(s)'}`,
                descontoSolicitado: resultado.percentualDesconto ?? null,
                criadoEm: new Date().toISOString(),
            }
            mem.aguardandoDesconto.push(desconto)
        }

        if (resultado.pedidoConfirmado) {
            pedido = registrarPedidoFechado(mem, conversa)
        }
    })

    // Efeitos de rede (mensagem ao Maurício, post no grupo) ficam fora do lock
    if (desconto) {
        console.log(`⚠️ [ZVendas] Desconto solicitado por ${desconto.cliente} — aguardando Maurício`)
        notificarMauricio(
            `⚠️ *ZVendas — desconto solicitado*\n\nCliente: ${desconto.cliente}\nPedido: ${desconto.pedido}\nDesconto pedido: ${desconto.descontoSolicitado ? desconto.descontoSolicitado + '%' : 'não especificado'}\n\nResponda "autoriza X%" ou "não autoriza".\nID: ${desconto.idDecisao}`
        )
    }
    if (pedido) {
        await anunciarPedidoFechado(jid, pedido)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Verificação periódica de clientes sem resposta (ciclo 3min) — segurança contra
// mensagens que chegaram mas nunca foram processadas (ex: gap de restart do serviço).
// ─────────────────────────────────────────────────────────────────────────────

// Só as 3 etiquetas de conversa ativa em aberto — "Seguir depois" fica de fora de propósito
// (o cliente pediu explicitamente pra falar depois, cutucar de novo em minutos é o oposto
// do que ele pediu). "Cliente" (fechado) e "Não interessado" também ficam fora.
const ETIQUETAS_VERIFICACAO = new Set([ETIQUETAS.novoCliente, ETIQUETAS.emAndamento, ETIQUETAS.propostaEnviada])

async function verificarClientesSemResposta() {
    const agora = Date.now()
    const { ativos, pendentes } = await comMemoria(mem => {
        const ativos = mem.conversasAtivas.filter(c => ETIQUETAS_VERIFICACAO.has(c.estagio))
        const pendentes = ativos
            .filter(c => c.historico.length > 0 && c.historico[c.historico.length - 1].de === 'cliente')
            .filter(c => agora - new Date(c.historico[c.historico.length - 1].em).getTime() > 2 * 60 * 1000)
            .map(c => ({ jid: c.jid, nome: c.nome || c.empresa || c.telefone, telefone: c.telefone, etiqueta: c.estagio }))
        return { ativos: ativos.length, pendentes }
    })
    console.log(`🏷️ [ZVendas] Verificando etiquetas — ${ativos} contatos ativos`)

    for (const p of pendentes) {
        console.log(`💬 [ZVendas] Respondendo cliente com etiqueta ${p.etiqueta}: ${p.nome}`)
        try {
            await gerarEEnviarRespostaClaude(p.jid, p.nome)
            console.log(`✅ [ZVendas] Resposta enviada para ${p.nome}`)
        } catch (err) {
            console.error(`❌ [ZVendas] Erro ao responder ${p.nome} na verificação periódica:`, err.message)
        }
    }
}

// Follow-up 1 (3 dias) / Follow-up 2 (+6 dias) / "Não interessado" se ainda assim
// silêncio — só pra quem recebeu a Mensagem 1 e nunca respondeu nada (aguardandoResposta
// só vira false quando a pessoa responde de verdade, ver hook em tratarMensagemRecebida —
// por isso um follow-up nunca é mandado depois que a pessoa já respondeu).
async function verificarFollowUpsPendentes() {
    const agora = Date.now()
    const acoes = await comMemoria(mem => mem.empresasContatadas
        .filter(e => e.status === 'contatado' && e.aguardandoResposta === true && e.etiqueta !== ETIQUETAS.naoInteressado)
        .map(e => {
            if (e.followupsEnviados === 0 && e.dataContato && agora - new Date(e.dataContato).getTime() >= DIAS_FOLLOWUP_1 * 24 * 60 * 60 * 1000) {
                return { tipo: 'fu1', telefone: e.telefone, jid: e.jid, nome: e.nome }
            }
            if (e.followupsEnviados === 1 && e.dataUltimoFollowup && agora - new Date(e.dataUltimoFollowup).getTime() >= DIAS_FOLLOWUP_2 * 24 * 60 * 60 * 1000) {
                return { tipo: 'fu2', telefone: e.telefone, jid: e.jid, nome: e.nome }
            }
            if (e.followupsEnviados >= 2) {
                return { tipo: 'fechar', telefone: e.telefone, jid: e.jid, nome: e.nome }
            }
            return null
        })
        .filter(Boolean))

    for (const acao of acoes) {
        try {
            if (acao.tipo === 'fechar') {
                await aplicarEtiqueta(acao.jid, ETIQUETAS.naoInteressado)
                await comMemoria(mem => {
                    const emp = mem.empresasContatadas.find(e => normalizarTelefone(e.telefone) === normalizarTelefone(acao.telefone))
                    if (emp && emp.aguardandoResposta) {
                        emp.etiqueta = ETIQUETAS.naoInteressado
                        emp.aguardandoResposta = false
                    }
                })
                console.log(`🚫 [ZVendas] Sem resposta após 2 follow-ups: ${acao.nome} → Não interessado`)
                continue
            }

            const texto = acao.tipo === 'fu1' ? MENSAGEM_FOLLOWUP_1 : MENSAGEM_FOLLOWUP_2
            await enviarMensagem(acao.jid, texto)
            await comMemoria(mem => {
                const emp = mem.empresasContatadas.find(e => normalizarTelefone(e.telefone) === normalizarTelefone(acao.telefone))
                if (emp && emp.aguardandoResposta) {
                    emp.followupsEnviados = acao.tipo === 'fu1' ? 1 : 2
                    emp.dataUltimoFollowup = new Date().toISOString()
                }
                const conversa = mem.conversasAtivas.find(c => normalizarTelefone(c.telefone) === normalizarTelefone(acao.telefone))
                if (conversa) conversa.historico.push({ de: 'zvendas', texto, em: new Date().toISOString() })
            })
            console.log(`📨 [ZVendas] ${acao.tipo === 'fu1' ? 'Follow-up 1' : 'Follow-up 2'} enviado: ${acao.nome}`)
        } catch (err) {
            console.error(`❌ [ZVendas] Erro no follow-up de ${acao.nome}:`, err.message)
        }
    }
}

function agendarVerificacaoClientesSemResposta() {
    verificarClientesSemResposta().catch(err => console.error('❌ [ZVendas] Erro na verificação periódica:', err.message))
    verificarFollowUpsPendentes().catch(err => console.error('❌ [ZVendas] Erro na verificação de follow-ups:', err.message))
    setInterval(() => {
        verificarClientesSemResposta().catch(err => console.error('❌ [ZVendas] Erro na verificação periódica:', err.message))
        verificarFollowUpsPendentes().catch(err => console.error('❌ [ZVendas] Erro na verificação de follow-ups:', err.message))
    }, 3 * 60 * 1000)
}

// ─────────────────────────────────────────────────────────────────────────────
// Desconto — resposta do Maurício (via Zaya, repasse de decisão zv_<id>)
// ─────────────────────────────────────────────────────────────────────────────

async function tratarRespostaDesconto(idDecisao, resposta) {
    const pendente = await comMemoria(mem => {
        const idx = mem.aguardandoDesconto.findIndex(d => d.idDecisao === idDecisao)
        if (idx < 0) return null
        const p = mem.aguardandoDesconto[idx]
        mem.aguardandoDesconto.splice(idx, 1)
        return p
    })
    if (!pendente) {
        console.log(`⚠️ [ZVendas] Decisão ${idDecisao} não encontrada (já respondida ou expirada)`)
        return
    }

    const respostaLower = resposta.toLowerCase()
    const autorizado = /autoriza/.test(respostaLower) && !/n[aã]o\s*autoriza/.test(respostaLower)
    const matchPercentual = resposta.match(/(\d{1,2})\s*%/)
    const percentual = matchPercentual ? Number(matchPercentual[1]) : pendente.descontoSolicitado

    const mensagemCliente = autorizado
        ? `Consegui aprovar sim! ${percentual ? `${percentual}% de desconto` : 'Um desconto'} pra você 😊`
        : 'Verifiquei aqui e infelizmente não vai ser possível dessa vez — mas o preço já está bem justo!'

    try {
        await enviarMensagem(pendente.jid, mensagemCliente)
        await comMemoria(mem => {
            const conversa = mem.conversasAtivas.find(c => c.jid === pendente.jid)
            if (conversa) conversa.historico.push({ de: 'zvendas', texto: mensagemCliente, em: new Date().toISOString() })
        })
    } catch (err) {
        console.error('❌ [ZVendas] Erro ao enviar resposta de desconto ao cliente:', err.message)
    }

    console.log(`🛍️ [ZVendas] Desconto ${autorizado ? 'autorizado' : 'negado'} repassado a ${pendente.cliente}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Servidor HTTP
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/incoming-message') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
            try {
                const { from, text, pushName, ehInterativo, temMidia, arteCaminho, downloadFalhou, audioTranscricaoFalhou, key, messageTimestamp } = JSON.parse(body)
                if (from && text) {
                    tratarMensagemRecebida(from, text, pushName, !!ehInterativo, !!temMidia, arteCaminho || null, !!downloadFalhou, !!audioTranscricaoFalhou, key || null, messageTimestamp || null).catch(err =>
                        console.error('❌ [ZVendas] Erro ao tratar mensagem recebida:', err.message))
                }
            } catch (err) {
                console.error('❌ /incoming-message erro ao parsear body:', err.message)
            }
        })

    } else if (req.method === 'POST' && req.url === '/resposta-mauricio') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true }))
            try {
                const { idDecisao, resposta } = JSON.parse(body)
                if (idDecisao) {
                    tratarRespostaDesconto(idDecisao, resposta || '').catch(err =>
                        console.error('❌ [ZVendas] Erro ao tratar resposta de desconto:', err.message))
                }
            } catch (err) {
                console.error('❌ /resposta-mauricio erro ao parsear body:', err.message)
            }
        })

    } else if (req.url === '/health') {
        res.writeHead(200)
        res.end('ok')

    } else {
        res.writeHead(404)
        res.end()
    }
})
// ─────────────────────────────────────────────────────────────────────────────

// Só entra em produção de verdade (server, ciclos automáticos) quando rodado
// diretamente (`node zvendas.js`) — requerer este módulo (ex: pra testes/simulação
// via `node -e`) NUNCA deve abrir porta nem começar a raspar/mandar mensagem sozinho.
if (require.main === module) {
    console.log('⚡ Iniciando ZVendas...')
    console.log('🔍 Prospecção automática: 24h, só empresas "aberto agora", intervalos progressivos 1/2/4/8/16/32min depois fixo 64min (±30s), 8-10 empresas/ciclo (fixo descartado antes de checar WhatsApp), 15-25/dia')
    console.log('🔀 Canal: empresas novas alternam entre "zaya" e "matheus" (zvendas_memoria.json compartilhado) — este processo só aborda as do canal "zaya"')
    console.log('📱 Abordagem inicial: ciclo 15-40min, 2 mensagens (saudação + "Tudo bem?") com 8-15s de intervalo, depois aguarda resposta')
    console.log('💬 Atendimento: 24h, delay de digitação humanizado 3-30s (com indicador "digitando...") antes de cada mensagem')
    console.log('🔍 Verificação de clientes sem resposta: ciclo 3min, responde quem esperou mais de 2min')
    console.log('📨 Follow-up: ciclo 3min, follow-up 1 em 3 dias / follow-up 2 em +6 dias / "Não interessado" se continuar em silêncio')
    server.listen(PORT, () => console.log(`🚀 ZVendas HTTP server na porta ${PORT}`))
    agendarProspeccao()
    agendarAbordagens()
    agendarAtualizacaoCatalogo()
    agendarVerificacaoClientesSemResposta()
}

module.exports = {
    // exportado só pra permitir testes/simulação isolada (node -e)
    carregarMemoria, salvarMemoria, memoriaPadrao, normalizarTelefone, comMemoria,
    buscarEmpresasNoMaps, cicloProspeccao, gerarAbordagem, abordarEmpresa, saudacaoPorHorario,
    tratarMensagemRecebida, tratarRespostaDesconto, registrarPedidoFechado, anunciarPedidoFechado,
    somarDiasUteis, formatarDataBR, montarSystemPrompt, chamarClaudeVendedor,
    pareceRespostaDeBot, ETIQUETAS,
    enviarMensagem, enviarMensagemGrupo, enviarImagemGrupo, aplicarEtiqueta, notificarMauricio,
    calcularDelayDigitacaoMs, agruparPorTurno, pareceQuererCatalogo, obterLinkCatalogo, obterLinkAvaliacoes,
    enviarProduto, enviarCatalogoNaConversa, gerarEEnviarRespostaClaude,
    verificarClientesSemResposta, agendarVerificacaoClientesSemResposta, verificarFollowUpsPendentes,
    carregarCatalogo, agendarAtualizacaoCatalogo, proximoCanal, processarProximaAbordagem,
}
