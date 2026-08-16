// ─────────────────────────────────────────────────────────────────────────────
// zmatheus.js — Canal 2 de prospecção (número do Matheus), processo simples e
// standalone: SEM Claude, SEM Groq, SEM atendimento. Só descobre empresas novas no
// Google Maps (mesma lógica do ZVendas, via maps-prospeccao.js), manda 2 mensagens
// fixas (saudação + "Tudo bem?") e PARA — nunca responde nada depois disso.
//
// Conecta ao WhatsApp via Baileys DIRETO (sessão própria, auth_info_matheus/) — ao
// contrário do zvendas.js, que não tem sessão própria e passa tudo pela sessão da
// Zaya via HTTP. Compartilha zvendas_memoria.json com o zvendas.js (mesmo arquivo,
// caminho fixo) só pra: (1) nunca abordar uma empresa que o outro canal já abordou,
// (2) alternar a atribuição de canal de cada empresa nova (ver proximoCanal).
//
// Duplica de propósito um pouco de código já existente em zvendas.js/Zaya.js
// (comMemoria, garantirLabel etc.) em vez de dar require nos dois arquivos — evitaria
// registrar handlers de processo (uncaughtException) duplicados e mantém este
// arquivo standalone, como pede o pedido ("processo simples").
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config()

process.on('uncaughtException', (err) => {
    console.error('[ZMatheus ERRO FATAL]', err.message)
})
process.on('unhandledRejection', (err) => {
    console.error('[ZMatheus PROMISE REJEITADA]', err?.message || err)
})

const fs = require('fs')
const path = require('path')
const http = require('http')
const { Boom } = require('@hapi/boom')
const qrcode = require('qrcode-terminal')
const pino = require('pino')
const { TERMOS_BUSCA, buscarEmpresasNoMaps, pareceCelular } = require('./maps-prospeccao')

const esperar = ms => new Promise(r => setTimeout(r, ms))
const aleatorioEntre = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

const PORT = process.env.ZMATHEUS_PORT || 3005
const MATHEUS_PHONE = process.env.MATHEUS_PHONE || '5511946231144'
const PROFILE_DIR = path.join(__dirname, 'zmatheus_profile')
const AUTH_DIR = path.join(__dirname, 'auth_info_matheus')
const ARQUIVO_LABELS = path.join(__dirname, 'zmatheus_labels.json')
// Mesmo arquivo do zvendas.js — SEMPRE o caminho compartilhado, exceto quando um
// teste isolado sobrescreve via env (nunca testar contra o caminho padrão, é o
// estado real de produção do canal Zaya também).
const ARQUIVO_MEMORIA = process.env.ZVENDAS_MEMORIA_PATH || path.join(__dirname, 'zvendas_memoria.json')

const ETIQUETAS = { novoCliente: 'Novo cliente' } // único estágio que esse canal usa

let activeSock = null
let reconnectTimer = null

// ─────────────────────────────────────────────────────────────────────────────
// Memória compartilhada (zvendas_memoria.json) — mesmo padrão comMemoria do
// zvendas.js, só os campos que este arquivo realmente lê/escreve são defaultados
// aqui; o resto (conversasAtivas, pedidosFechados etc.) sobrevive ao round-trip
// carregar→salvar mesmo sem estar declarado (spread de objeto preserva tudo que
// já existir no arquivo real, mesmo campos que este memoriaPadrao() não conhece).
// ─────────────────────────────────────────────────────────────────────────────

function memoriaPadrao() {
    return {
        empresasContatadas: [],
        proximoCanalIndex: 0,
        contadorDiarioMatheus: { data: null, quantidade: 0, meta: 0 },
        sequenciaBuscaMatheus: { data: null, proximaBuscaNumero: 1 },
    }
}

function carregarMemoria() {
    try {
        if (!fs.existsSync(ARQUIVO_MEMORIA)) return memoriaPadrao()
        return { ...memoriaPadrao(), ...JSON.parse(fs.readFileSync(ARQUIVO_MEMORIA, 'utf8')) }
    } catch (err) {
        console.error('⚠️ [ZMatheus] Erro ao carregar zvendas_memoria.json, usando padrão:', err.message)
        return memoriaPadrao()
    }
}

function salvarMemoria(mem) {
    try {
        fs.writeFileSync(ARQUIVO_MEMORIA, JSON.stringify(mem, null, 2), 'utf8')
    } catch (err) {
        console.error('⚠️ [ZMatheus] Erro ao salvar zvendas_memoria.json:', err.message)
    }
}

// Mesma serialização por fila usada em zvendas.js — evita que uma prospecção e uma
// abordagem concorrentes (dentro DESTE processo) pisem uma na escrita da outra.
// Não há lock entre processos (zvendas.js roda separado) — risco aceito, ver
// comentário completo em proximoCanal (zvendas.js).
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

function normalizarTelefone(tel) {
    return String(tel || '').replace(/@.*$/, '').replace(/:.*$/, '').replace(/\D/g, '').replace(/^55/, '')
}

// Idêntico ao de zvendas.js (mesmo campo mem.proximoCanalIndex, mesmo arquivo) —
// duplicado aqui de propósito, ver comentário no topo do arquivo.
function proximoCanal(mem) {
    const idx = mem.proximoCanalIndex || 0
    mem.proximoCanalIndex = idx + 1
    return idx % 2 === 0 ? 'zaya' : 'matheus'
}

// ─────────────────────────────────────────────────────────────────────────────
// Etiquetas (Baileys direto — este canal tem sessão própria, sem proxy pela Zaya)
// ─────────────────────────────────────────────────────────────────────────────

function normalizarNomeLabel(nome) {
    return String(nome || '').trim().toLowerCase()
}

function carregarLabelsMap() {
    try { return JSON.parse(fs.readFileSync(ARQUIVO_LABELS, 'utf8')) } catch { return {} }
}

function salvarLabelsMap(mapa) {
    try { fs.writeFileSync(ARQUIVO_LABELS, JSON.stringify(mapa, null, 2), 'utf8') } catch (err) {
        console.error('❌ [ZMatheus] Erro ao salvar zmatheus_labels.json:', err.message)
    }
}

// Só CRIA a etiqueta se ela ainda não existir na conta do Matheus (mesmo padrão de
// garantirLabel em Zaya.js) — "Novo cliente" pode já ter sido cadastrada manualmente.
async function garantirLabel(sock, nome) {
    const chave = normalizarNomeLabel(nome)
    const mapa = carregarLabelsMap()
    if (mapa[chave]) return mapa[chave].id

    const idsExistentes = Object.values(mapa).map(l => Number(l.id)).filter(n => !Number.isNaN(n))
    const novoId = String((idsExistentes.length ? Math.max(...idsExistentes) : 0) + 1)
    await sock.addLabel('', { id: novoId, name: nome, color: 0, predefinedId: null, deleted: false })
    mapa[chave] = { id: novoId, nome }
    salvarLabelsMap(mapa)
    console.log(`🏷️  [ZMatheus] Etiqueta "${nome}" não encontrada na sincronização — criada agora (id ${novoId})`)
    return novoId
}

async function aplicarLabelContato(sock, jid, nome) {
    const id = await garantirLabel(sock, nome)
    await sock.addChatLabel(jid, id)
    console.log(`🏷️  [ZMatheus] addChatLabel confirmado pelo WhatsApp: ${jid} → "${nome}" (id ${id})`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Prospecção — mesma lógica do zvendas.js (Google Maps, "aberto agora", intervalos
// progressivos, meta diária 15-25), canal "matheus" (contadorDiarioMatheus,
// sequenciaBuscaMatheus são campos PRÓPRIOS — não competem com os do zvendas.js).
// ─────────────────────────────────────────────────────────────────────────────

async function checarWhatsapp(sock, telefone) {
    const base = String(telefone).replace(/\D/g, '')
    const comCC = base.startsWith('55') ? base : `55${base}`
    const resultado = await sock.onWhatsApp(comCC)
    const encontrado = resultado?.[0]
    return { temWhatsapp: !!encontrado?.exists, jid: encontrado?.jid || null }
}

async function cicloProspeccao(sock) {
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
    const { restante } = await comMemoria(mem => {
        if (mem.contadorDiarioMatheus.data !== hoje) {
            mem.contadorDiarioMatheus = { data: hoje, quantidade: 0, meta: aleatorioEntre(15, 25) }
        }
        return { restante: mem.contadorDiarioMatheus.meta - mem.contadorDiarioMatheus.quantidade }
    })
    if (restante <= 0) {
        console.log(`🔍 [ZMatheus] Meta diária atingida — pulando ciclo`)
        return
    }

    const termo = TERMOS_BUSCA[Math.floor(Math.random() * TERMOS_BUSCA.length)]
    console.log(`🔍 [ZMatheus] Buscando empresas em São Paulo — termo: ${termo}`)

    let encontradas = []
    try {
        // 20 (não só 8-10) de propósito — parte considerável descarta como fixo antes
        // mesmo de checar WhatsApp, precisa de matéria-prima extra pra sobrar 8-10 bons.
        encontradas = await buscarEmpresasNoMaps(termo, 20, PROFILE_DIR)
    } catch (err) {
        console.error('❌ [ZMatheus] Erro na busca do Google Maps:', err.message)
        return
    }

    // Descarta quem já está na lista (dos dois canais) antes de gastar chamada de
    // rede verificando WhatsApp — é isso que garante nunca sobrepor com o ZVendas.
    const jaContatadasAntes = await comMemoria(mem => new Set(mem.empresasContatadas.map(e => normalizarTelefone(e.telefone))))
    const candidatas = encontradas.filter(e => !jaContatadasAntes.has(normalizarTelefone(e.telefone)))

    // Fixo é descartado ANTES até de gastar a chamada de rede — só celular (DDD + 9
    // dígitos) pode ter WhatsApp de verdade.
    const comWhatsapp = []
    for (const emp of candidatas) {
        if (comWhatsapp.length >= restante) break
        if (!pareceCelular(emp.telefone)) {
            console.log(`📵 [ZMatheus] Número fixo ignorado: ${emp.telefone}`)
            continue
        }
        let temWhatsapp = false
        try {
            const r = await checarWhatsapp(sock, emp.telefone)
            temWhatsapp = r.temWhatsapp
        } catch (err) {
            console.error(`⚠️ [ZMatheus] Erro ao verificar WhatsApp de ${emp.telefone}: ${err.message}`)
        }
        console.log(`📱 [ZMatheus] ${emp.telefone} — WhatsApp: ${temWhatsapp ? 'sim' : 'não'}`)
        if (temWhatsapp) comWhatsapp.push(emp)
    }

    await comMemoria(mem => {
        if (mem.contadorDiarioMatheus.data !== hoje) {
            mem.contadorDiarioMatheus = { data: hoje, quantidade: 0, meta: aleatorioEntre(15, 25) }
        }
        const jaContatadas = new Set(mem.empresasContatadas.map(e => normalizarTelefone(e.telefone)))
        const restanteAgora = mem.contadorDiarioMatheus.meta - mem.contadorDiarioMatheus.quantidade
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
        mem.contadorDiarioMatheus.quantidade += novas.length
        console.log(`🔍 [ZMatheus] ${novas.length} nova(s) empresa(s) salva(s) (termo: ${termo}, meta do dia: ${mem.contadorDiarioMatheus.quantidade}/${mem.contadorDiarioMatheus.meta})`)
    })
}

const DELAYS_PROGRESSIVOS_MIN = [1, 2, 4, 8, 16, 32]

function proximoDelayBuscaMinutos(numeroBusca) {
    const idx = numeroBusca - 1
    return idx < DELAYS_PROGRESSIVOS_MIN.length ? DELAYS_PROGRESSIVOS_MIN[idx] : 64
}

function agendarProspeccao(sock) {
    ;(async () => {
        const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
        const numeroBusca = await comMemoria(mem => {
            if (!mem.sequenciaBuscaMatheus || mem.sequenciaBuscaMatheus.data !== hoje) {
                mem.sequenciaBuscaMatheus = { data: hoje, proximaBuscaNumero: 1 }
            }
            return mem.sequenciaBuscaMatheus.proximaBuscaNumero
        })
        const delayMin = proximoDelayBuscaMinutos(numeroBusca)
        const jitterMs = aleatorioEntre(-30, 30) * 1000
        const esperaMs = Math.max(5000, delayMin * 60 * 1000 + jitterMs)
        console.log(`🔍 [ZMatheus] Busca #${numeroBusca} em ~${delayMin}min`)

        setTimeout(async () => {
            await cicloProspeccao(sock).catch(err => console.error('❌ [ZMatheus] Erro no ciclo de prospecção:', err.message))
            await comMemoria(mem => {
                if (!mem.sequenciaBuscaMatheus || mem.sequenciaBuscaMatheus.data !== hoje) {
                    mem.sequenciaBuscaMatheus = { data: hoje, proximaBuscaNumero: 1 }
                }
                mem.sequenciaBuscaMatheus.proximaBuscaNumero = numeroBusca + 1
            })
            agendarProspeccao(sock)
        }, esperaMs)
    })()
}

// ─────────────────────────────────────────────────────────────────────────────
// Abordagem — 2 mensagens fixas (saudação do horário + "Tudo bem?"), 8-15s de
// intervalo, etiqueta "Novo cliente", e PARA. Sem Claude, sem Groq, sem 3ª
// mensagem, sem reagir a respostas — esse canal é puramente de prospecção.
// ─────────────────────────────────────────────────────────────────────────────

function saudacaoPorHorario() {
    const hora = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }))
    if (hora >= 5 && hora < 12) return 'Bom dia!'
    if (hora >= 12 && hora < 18) return 'Boa tarde!'
    return 'Boa noite!'
}

const MENSAGEM_2 = 'Tudo bem?'

// Indicador "digitando..." antes de cada mensagem — mesmo espírito anti-detecção
// já usado no /send-message da Zaya (calcularDelayDigitacaoMs), só que fixo e
// simples aqui (esse canal não tem conteúdo variável pra calcular a partir dele).
async function enviarComPresenca(sock, jid, texto) {
    try { await sock.sendPresenceUpdate('composing', jid) } catch {}
    await esperar(aleatorioEntre(1500, 3500))
    try { await sock.sendPresenceUpdate('paused', jid) } catch {}
    await sock.sendMessage(jid, { text: texto })
}

async function abordarEmpresa(sock, empresa) {
    console.log(`📱 [ZMatheus] Abordando: ${empresa.nome}`)

    const { temWhatsapp, jid } = await checarWhatsapp(sock, empresa.telefone)
    if (!temWhatsapp || !jid) {
        console.error(`⚠️ [ZMatheus] ${empresa.nome} (${empresa.telefone}) não tem mais WhatsApp — marcando como contatado sem enviar`)
        await comMemoria(mem => {
            const idx = mem.empresasContatadas.findIndex(e => normalizarTelefone(e.telefone) === normalizarTelefone(empresa.telefone))
            if (idx >= 0) mem.empresasContatadas[idx].status = 'contatado'
        })
        return
    }

    const saudacao = saudacaoPorHorario()
    await enviarComPresenca(sock, jid, saudacao)
    await esperar(aleatorioEntre(8, 15) * 1000)
    await enviarComPresenca(sock, jid, MENSAGEM_2)
    await aplicarLabelContato(sock, jid, ETIQUETAS.novoCliente)

    await comMemoria(mem => {
        const idx = mem.empresasContatadas.findIndex(e => normalizarTelefone(e.telefone) === normalizarTelefone(empresa.telefone))
        if (idx >= 0) {
            mem.empresasContatadas[idx].status = 'contatado'
            mem.empresasContatadas[idx].etiqueta = ETIQUETAS.novoCliente
            mem.empresasContatadas[idx].jid = jid
            mem.empresasContatadas[idx].dataContato = new Date().toISOString()
            // aguardandoResposta fica false de propósito — esse canal não faz follow-up
            // nem espera resposta, ver cabeçalho do arquivo.
        }
    })

    console.log(`✅ [ZMatheus] Abordagem enviada: ${empresa.nome}`)
}

async function processarProximaAbordagem(sock) {
    const mem = carregarMemoria()
    const pendente = mem.empresasContatadas.find(e => e.status === 'pendente' && e.canal === 'matheus')
    if (!pendente) return
    await abordarEmpresa(sock, pendente)
}

function agendarAbordagens(sock) {
    processarProximaAbordagem(sock).catch(err => console.error('❌ [ZMatheus] Erro ao abordar empresa:', err.message))
    const proximo = aleatorioEntre(15, 40) * 60 * 1000
    setTimeout(() => agendarAbordagens(sock), proximo)
}

// ─────────────────────────────────────────────────────────────────────────────
// Conexão WhatsApp (Baileys, sessão própria — auth_info_matheus/)
// ─────────────────────────────────────────────────────────────────────────────

async function connectToWhatsApp() {
    const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, Browsers } = await import('@whiskeysockets/baileys')

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        markOnlineOnConnect: false,
    })

    sock.ev.on('creds.update', saveCreds)

    // Sincroniza etiquetas da conta do Matheus (mesmo padrão de Zaya.js) — garantirLabel
    // só cria uma nova se ela não aparecer aqui.
    sock.ev.on('labels.edit', (label) => {
        if (!label?.id || !label?.name) return
        const mapa = carregarLabelsMap()
        const chave = normalizarNomeLabel(label.name)
        if (label.deleted) delete mapa[chave]
        else mapa[chave] = { id: label.id, nome: label.name }
        salvarLabelsMap(mapa)
        console.log(`🏷️  [ZMatheus] Etiqueta sincronizada: "${label.name}" (id ${label.id})${label.deleted ? ' [removida]' : ''}`)
    })

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
            console.log('\n📱 Escaneie o QR code abaixo com o WhatsApp do Matheus:\n')
            qrcode.generate(qr, { small: true })
        }

        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
            activeSock = null

            if (statusCode === DisconnectReason.loggedOut) {
                console.log('🚪 Dispositivo desconectado pelo WhatsApp — limpando sessão e gerando novo QR code...')
                try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }) } catch {}
                if (reconnectTimer) clearTimeout(reconnectTimer)
                reconnectTimer = setTimeout(() => { reconnectTimer = null; connectToWhatsApp() }, 3000)
            } else if (statusCode === DisconnectReason.connectionReplaced) {
                console.log('⚠️ Sessão substituída (440) — deletando auth e exibindo novo QR code...')
                try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }) } catch {}
                if (reconnectTimer) clearTimeout(reconnectTimer)
                reconnectTimer = setTimeout(() => { reconnectTimer = null; connectToWhatsApp() }, 3000)
            } else {
                if (reconnectTimer) clearTimeout(reconnectTimer)
                console.log(`🔄 Reconectando em 5s... (código ${statusCode})`)
                reconnectTimer = setTimeout(() => { reconnectTimer = null; connectToWhatsApp() }, 5000)
            }
        } else if (connection === 'open') {
            console.log('✅ ZMatheus está online!')
            activeSock = sock
            agendarProspeccao(sock)
            agendarAbordagens(sock)
        }
    })

    // Esse canal não atende — só loga o recebimento, por visibilidade, e não faz
    // mais nada com a mensagem (nem marca como lida, nem responde).
    sock.ev.on('messages.upsert', ({ messages, type }) => {
        if (type !== 'notify' && type !== 'append') return
        for (const msg of messages) {
            if (msg.key.fromMe || !msg.key.remoteJid) continue
            console.log(`📨 [ZMatheus] Mensagem recebida de ${msg.key.remoteJid} — ignorada (canal só prospecta, não atende)`)
        }
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Servidor HTTP (só /health — nenhum outro processo precisa chamar o ZMatheus)
// ─────────────────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200)
        res.end('ok')
    } else {
        res.writeHead(404)
        res.end()
    }
})

// Só entra em produção de verdade (conexão WhatsApp, server, prospecção automática)
// quando rodado diretamente (`node zmatheus.js`) — requerer este módulo (testes)
// nunca deve abrir porta nem conectar sozinho.
if (require.main === module) {
    console.log('⚡ Iniciando ZMatheus...')
    console.log(`📱 Conectando ao WhatsApp do Matheus (${MATHEUS_PHONE}) — auth em ${AUTH_DIR}`)
    console.log('🔍 Prospecção: mesma lógica do ZVendas (Google Maps, "aberto agora"), 8-10 empresas/ciclo (fixo descartado antes de checar WhatsApp), canal "matheus", zvendas_memoria.json compartilhado')
    console.log('📨 Abordagem: 2 mensagens fixas (saudação + "Tudo bem?"), 8-15s de intervalo — sem IA, sem atendimento, para depois disso')
    server.listen(PORT, () => console.log(`🚀 ZMatheus HTTP server na porta ${PORT}`))
    connectToWhatsApp()
}

module.exports = {
    // exportado só pra permitir testes/simulação isolada (node -e)
    carregarMemoria, salvarMemoria, memoriaPadrao, normalizarTelefone, comMemoria, proximoCanal,
    cicloProspeccao, abordarEmpresa, saudacaoPorHorario, processarProximaAbordagem,
    checarWhatsapp, ETIQUETAS,
}
