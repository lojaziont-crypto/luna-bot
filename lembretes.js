// ─────────────────────────────────────────────────────────────────────────────
// lembretes.js — Lembretes/compromissos pessoais do Maurício (Zaya).
//
// Persistência em zaya_lembretes.json: { lembretes: [{id, evento, dataHora,
// enviado, criadoEm}] }. Groq só extrai QUAIS trechos da mensagem são o evento,
// o horário e a data (NLU) — a conversão desses trechos em data/hora exatas
// (parseHorarioTexto/parseDataTexto) é feita aqui em JS puro, determinístico:
// não dá pra confiar em aritmética de data (ex: "sexta" → qual dia exato) numa
// LLM pra um lembrete que precisa disparar na hora certa.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config()

const fs = require('fs')
const path = require('path')
const Groq = require('groq-sdk')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const LEMBRETES_FILE = path.join(__dirname, 'zaya_lembretes.json')

function carregarLembretes() {
    try {
        if (fs.existsSync(LEMBRETES_FILE)) {
            const dados = JSON.parse(fs.readFileSync(LEMBRETES_FILE, 'utf8'))
            if (Array.isArray(dados.lembretes)) return dados.lembretes
        }
    } catch {}
    return []
}

function salvarLembretes(lembretes) {
    fs.writeFileSync(LEMBRETES_FILE, JSON.stringify({ lembretes }, null, 2))
}

function capitalizar(nome) {
    const n = String(nome || '').trim()
    return n.charAt(0).toUpperCase() + n.slice(1)
}

// ───────────────────────── Datas (America/Sao_Paulo, sem depender de timezone do host) ─────────────────────────

function hojeISO() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}

// Aritmética de calendário em UTC "puro" (meio-dia fictício) — evita qualquer
// deslocamento de DST/timezone, já que aqui só interessa o dia civil, não a hora.
function somarDias(dataISO, dias) {
    const [y, m, d] = dataISO.split('-').map(Number)
    const dt = new Date(Date.UTC(y, m - 1, d + dias))
    return dt.toISOString().slice(0, 10)
}

function diaDaSemana(dataISO) {
    const [y, m, d] = dataISO.split('-').map(Number)
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=domingo ... 6=sábado
}

const NOMES_DIA_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']

const MAPA_ACENTOS = { á: 'a', à: 'a', â: 'a', ã: 'a', é: 'e', ê: 'e', í: 'i', ó: 'o', ô: 'o', õ: 'o', ú: 'u', ç: 'c' }

function normalizarAcento(s) {
    return s.replace(/[áàâãéêíóôõúç]/g, c => MAPA_ACENTOS[c])
}

// Converte o trecho de data como foi dito ("hoje", "amanhã", "sexta", "15/08") pra
// "AAAA-MM-DD". Retorna null se não reconhecer nada. "sexta" dito num dia que já É
// sexta conta como hoje (leitura mais comum), não a próxima semana.
function parseDataTexto(raw, hojeISOStr = hojeISO()) {
    if (!raw) return null
    const t = normalizarAcento(String(raw).toLowerCase().trim())

    if (/\bdepois de amanha\b/.test(t)) return somarDias(hojeISOStr, 2)
    if (/\bamanha\b/.test(t)) return somarDias(hojeISOStr, 1)
    if (/\bhoje\b/.test(t)) return hojeISOStr

    const md = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/)
    if (md) {
        const dia = Number(md[1])
        const mes = Number(md[2])
        let ano = md[3] ? Number(md[3]) : Number(hojeISOStr.slice(0, 4))
        if (ano < 100) ano += 2000
        if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null
        return `${String(ano).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`
    }

    for (let i = 0; i < NOMES_DIA_SEMANA.length; i++) {
        const nome = normalizarAcento(NOMES_DIA_SEMANA[i])
        if (t.includes(nome)) {
            const hojeDow = diaDaSemana(hojeISOStr)
            let diff = i - hojeDow
            if (diff < 0) diff += 7
            return somarDias(hojeISOStr, diff)
        }
    }

    return null
}

// Converte o trecho de horário como foi dito ("9 horas", "14h", "15:30", "9h30",
// "10") pra "HH:MM" (24h). Retorna null se não reconhecer nada.
function parseHorarioTexto(raw) {
    if (!raw) return null
    let t = String(raw).toLowerCase().trim()
    t = t.replace(/\b(às|as|por volta de|perto de|umas)\b/g, '').trim()

    let m = t.match(/\b([01]?\d|2[0-3])[:h](\d{2})\b/)
    if (m) {
        const h = Number(m[1])
        const min = Number(m[2])
        if (h > 23 || min > 59) return null
        return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
    }

    m = t.match(/\b([01]?\d|2[0-3])\s*h(oras)?\b/)
    if (m) return `${String(Number(m[1])).padStart(2, '0')}:00`

    m = t.match(/\b([01]?\d|2[0-3])\b/)
    if (m) return `${String(Number(m[1])).padStart(2, '0')}:00`

    return null
}

// "hoje" / "amanhã" / nome do dia da semana (se estiver nos próximos 6 dias) / "DD/MM"
function formatarRelativo(dataISO, hojeISOStr = hojeISO()) {
    if (dataISO === hojeISOStr) return 'hoje'
    if (dataISO === somarDias(hojeISOStr, 1)) return 'amanhã'
    const diffDias = Math.round((Date.parse(dataISO + 'T00:00:00Z') - Date.parse(hojeISOStr + 'T00:00:00Z')) / 86400000)
    if (diffDias > 1 && diffDias < 7) return NOMES_DIA_SEMANA[diaDaSemana(dataISO)]
    const [, m, d] = dataISO.split('-')
    return `${d}/${m}`
}

// dataHora é sempre um wall-clock de America/Sao_Paulo (schema pedido, sem offset
// no JSON: "AAAA-MM-DDTHH:MM:00") — nunca dá pra passar direto pro Date() nativo,
// que assume o timezone local do HOST. Em dev (máquina do Maurício) isso coincide
// com São Paulo, mas em produção (Railway, tipicamente UTC) daria lembrete disparando
// com horas de diferença. Brasil não tem mais horário de verão desde 2019 — São Paulo
// é sempre UTC-3 fixo, então basta anexar o offset antes de converter.
function paraInstante(dataHoraNaive) {
    return new Date(`${dataHoraNaive}-03:00`)
}

// ───────────────────────── CRUD ─────────────────────────

function proximoId(lembretes) {
    const max = lembretes.reduce((acc, l) => Math.max(acc, Number(l.id) || 0), 0)
    return String(max + 1)
}

// dataHora já resolvida, formato "AAAA-MM-DDTHH:MM:00"
function criarLembrete({ evento, dataHora }) {
    const lembretes = carregarLembretes()
    const novo = {
        id: proximoId(lembretes),
        evento: capitalizar(evento),
        dataHora,
        enviado: false,
        criadoEm: new Date().toISOString(),
    }
    lembretes.push(novo)
    salvarLembretes(lembretes)
    return novo
}

// Remove o lembrete (ainda não enviado) cujo evento bate com o termo — igualdade
// exata primeiro, depois substring nos dois sentidos. Retorna o lembrete removido,
// ou null se não achou (quem chama decide se intercepta a mensagem ou não).
function cancelarLembrete(termo) {
    const lembretes = carregarLembretes()
    const termoLower = String(termo || '').toLowerCase().trim()
    if (!termoLower) return null
    let idx = lembretes.findIndex(l => !l.enviado && l.evento.toLowerCase() === termoLower)
    if (idx === -1) {
        idx = lembretes.findIndex(l => !l.enviado && (l.evento.toLowerCase().includes(termoLower) || termoLower.includes(l.evento.toLowerCase())))
    }
    if (idx === -1) return null
    const [removido] = lembretes.splice(idx, 1)
    salvarLembretes(lembretes)
    return removido
}

function listarFuturos() {
    const agora = new Date()
    return carregarLembretes()
        .filter(l => !l.enviado && paraInstante(l.dataHora) > agora)
        .sort((a, b) => paraInstante(a.dataHora) - paraInstante(b.dataHora))
}

function formatarListaLembretes() {
    const futuros = listarFuturos()
    if (!futuros.length) return '📅 *Seus lembretes*\n\nVocê não tem lembretes agendados.'
    const linhas = futuros.map(l => {
        const [dataISO, horaISO] = l.dataHora.split('T')
        return `- ${horaISO.slice(0, 5)} — ${l.evento} (${formatarRelativo(dataISO)})`
    }).join('\n')
    return `📅 *Seus lembretes*\n\n${linhas}`
}

// Varre os lembretes não enviados: os que faltam ≤5min pro horário (e ainda não
// passaram de 60min de atraso, cobrindo uma reinicialização/queda breve da Zaya)
// entram na lista de disparo e já são marcados enviado=true (dedup — nunca dispara
// 2x). Os que já passaram de 60min sem nunca terem sido enviados só são marcados
// enviado=true, sem notificar (evita lembrete velho chegando do nada bem depois).
function verificarESepararParaDisparar() {
    const agora = new Date()
    const lembretes = carregarLembretes()
    const paraDisparar = []
    let mudou = false
    for (const l of lembretes) {
        if (l.enviado) continue
        const diffMin = (paraInstante(l.dataHora) - agora) / 60000
        if (diffMin <= 5 && diffMin > -60) {
            paraDisparar.push({ ...l, minutosRestantes: Math.max(0, Math.round(diffMin)) })
            l.enviado = true
            mudou = true
        } else if (diffMin <= -60) {
            l.enviado = true
            mudou = true
        }
    }
    if (mudou) salvarLembretes(lembretes)
    return paraDisparar
}

// Remove da persistência lembretes com mais de 24h após o horário — passados ou não
// (um "esquecido" não enviado por qualquer motivo também não faz sentido acumular).
function limparAntigos() {
    const agora = new Date()
    const lembretes = carregarLembretes()
    const restantes = lembretes.filter(l => (agora - paraInstante(l.dataHora)) < 24 * 60 * 60 * 1000)
    if (restantes.length !== lembretes.length) salvarLembretes(restantes)
    return lembretes.length - restantes.length
}

// ───────────────────────── Extração (Groq) ─────────────────────────

const PROMPT_LEMBRETE = `Você extrai informações de uma mensagem do dono de uma casa pra criar um LEMBRETE/COMPROMISSO.

Se a mensagem for um pedido pra criar um lembrete/compromisso (ex: "reunião às 9 horas", "lembrete dentista amanhã às 14h", "me lembra da call às 15:30", "não esquece da reunião sexta às 10"), extraia:
- "evento": nome curto do evento/compromisso (ex: "Reunião", "Dentista", "Call"), com inicial maiúscula, SEM incluir data/horário no nome.
- "horarioTexto": o trecho EXATO de horário como foi dito na mensagem (ex: "9 horas", "14h", "15:30", "10") — ou null se nenhum horário foi mencionado.
- "dataTexto": o trecho EXATO de data como foi dito na mensagem (ex: "amanhã", "sexta", "hoje", "15/08") — ou null se nenhuma data foi mencionada.

Se a mensagem NÃO for sobre criar um lembrete/compromisso (pergunta, dúvida financeira, outro assunto qualquer), responda {"evento": null, "horarioTexto": null, "dataTexto": null}.

Responda EXCLUSIVAMENTE em JSON:
{"evento": "..."|null, "horarioTexto": "..."|null, "dataTexto": "..."|null}`

// Retorna {evento, horarioTexto, dataTexto} (os dois últimos podem vir null) ou
// null se a mensagem não é sobre criar um lembrete (ou se a chamada falhar).
async function extrairEventoHorarioData(texto) {
    try {
        const resp = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            max_tokens: 150,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: PROMPT_LEMBRETE },
                { role: 'user', content: texto },
            ],
        })
        const bruto = JSON.parse(resp.choices[0].message.content)
        if (!bruto.evento) return null
        return {
            evento: capitalizar(String(bruto.evento).trim()),
            horarioTexto: bruto.horarioTexto ? String(bruto.horarioTexto).trim() : null,
            dataTexto: bruto.dataTexto ? String(bruto.dataTexto).trim() : null,
        }
    } catch (err) {
        console.log(`⚠️  [Lembretes] Falha ao extrair "${texto}": ${err.message}`)
        return null
    }
}

module.exports = {
    carregarLembretes,
    criarLembrete,
    cancelarLembrete,
    listarFuturos,
    formatarListaLembretes,
    formatarRelativo,
    parseHorarioTexto,
    parseDataTexto,
    hojeISO,
    extrairEventoHorarioData,
    verificarESepararParaDisparar,
    limparAntigos,
}
