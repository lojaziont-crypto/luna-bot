// ─────────────────────────────────────────────────────────────────────────────
// planner-agent.js — Cadastro de despesas no Meu Planner Financeiro (browser VISÍVEL,
// perfil persistente, login automático com credenciais do .env).
//
// - Navegador SEMPRE visível (headless: false) — o dono acompanha na tela.
// - Perfil persistente próprio (MeuPlannerProfile em LOCALAPPDATA).
// - Login automático se sessão expirar (PLANNER_EMAIL + PLANNER_PASSWORD do .env).
// - Usa puppeteer puro (não extra). Browser fica ABERTO entre lançamentos.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config()

const fs = require('fs')
const path = require('path')
const Groq = require('groq-sdk')
const rawPuppeteer = require('puppeteer')
const { resolverChrome } = require('./shopee-agent')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const PLANNER_URL = process.env.PLANNER_URL || 'https://web.meuplannerfinanceiro.com.br/login'
const PLANNER_BASE = 'https://web.meuplannerfinanceiro.com.br'
const LANCAMENTOS_URL = `${PLANNER_BASE}/controle/lancamentos`
const BALANCO_MENSAL_URL = `${PLANNER_BASE}/dashboard/mensal`
const PENDENCIAS_URL = `${PLANNER_BASE}/controle/pendencias`

// Perfil fora do diretório do projeto — Edge não aceita userDataDir dentro de pastas de repositório git
const PROFILE_DIR = process.env.PLANNER_PROFILE_DIR
    || path.join(process.env.LOCALAPPDATA || require('os').homedir(), 'MeuPlannerProfile')
const DEBUG_DIR = path.join(__dirname, 'debug_planner')
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR)

const TIMEOUT_LOGIN_MS = 5 * 60 * 1000 // 5 min aguardando login manual

// ───────────────────────── Planejamento mensal (fonte única) ─────────────────────────
// Estrutura: { categoria: { limite: number|null, subs: { subcategoria: number|null } } }
// limite/sub = valor planejado no mês; null = categoria/sub sem planejamento definido.
const PLANEJAMENTO = {
    'Academia': { limite: 139.90, subs: {} },
    'Alimentação': { limite: 220.00, subs: { 'Lanche': 90, 'Almoço': 60, 'Café da Manhã': 40, 'Jantar': 30 } },
    'Animal de Estimação': { limite: 100.00, subs: { 'Ração': 100 } },
    'Casa': { limite: 1740.00, subs: { 'Aluguel': 1450, 'Internet': 130, 'Água': 70, 'Luz': 70, 'Gás': 20 } },
    'Cuidados Pessoais': { limite: 90.00, subs: { 'Corte de Cabelo': 60, 'Produtos': 30 } },
    'Dízimo': { limite: null, subs: {} },
    'Eletrodomésticos, Móveis e Etc.': { limite: null, subs: {} },
    'Emergência': { limite: 100.00, subs: {} },
    'Farmácia': { limite: null, subs: {} },
    'Lavanderia': { limite: 66.00, subs: {} },
    'Lazer': { limite: 50.00, subs: { 'Viagem': 50 } },
    'Mercado': { limite: 500.00, subs: {} },
    'Outros': { limite: null, subs: { 'Outros': null } },
    'Transporte': { limite: 295.00, subs: { 'Metrô': 205, 'Ônibus': 90, '99': null, 'Uber': null } },
    'Vestuário': { limite: 30.00, subs: {} },
}

// Categorias de receita (aceitas na interpretação, sem planejamento de gasto)
const RECEITAS = ['Renda Extra', 'Salário', 'Vale-Alimentação', 'Vale-Transporte']

const CATEGORIAS_DESPESA = Object.keys(PLANEJAMENTO)

// Categorias sem limite definido — nunca sugeridas como "tem folga" no insight de estouro
const CATEGORIAS_SEM_LIMITE_PARA_SUGESTAO = ['Dízimo', 'Farmácia', 'Eletrodomésticos, Móveis e Etc.', 'Outros']

// ───────────────────────── Resumo financeiro diário (fonte única) ─────────────────────────
// Receita fixa mensal: Salário R$3.000 + Vale-Alimentação R$200 + Vale-Transporte R$280.
// Renda Extra lançada no mês é somada a isso (ver lerLancamentosDoMesAtual).
const RECEITA_BASE_MENSAL = 3480.00
// Pagas pela loja — nunca entram no total gasto pessoal do resumo diário
const CATEGORIAS_IGNORAR_RESUMO = ['Eletrodomésticos, Móveis e Etc.', 'Outros']

// Classificação por item (nome de subcategoria, ou de categoria quando ela não tem subs) — usada
// só na dica do resumo diário. Itens sem limite definido em PLANEJAMENTO (ex: Uber, 99, Farmácia)
// nunca aparecem na dica, pois não dá pra calcular "saldo disponível" sem um limite pra comparar.
const CATEGORIAS_ESSENCIAIS = ['Aluguel', 'Água', 'Luz', 'Gás', 'Internet', 'Mercado', 'Metrô', 'Ônibus', 'Academia', 'Animal de Estimação', 'Ração']
const CATEGORIAS_SEMI_ESSENCIAIS = ['Almoço', 'Lanche', 'Café da Manhã', 'Jantar', 'Farmácia', 'Cuidados Pessoais', 'Lavanderia']
const CATEGORIAS_NAO_ESSENCIAIS = ['Lazer', 'Viagem', 'Vestuário', 'Uber', '99']

// Guia de palavras informais → subcategoria/categoria (chave = nome EXATO já usado em PLANEJAMENTO).
// Serve tanto de referência pro prompt do Groq quanto de pré-filtro em pareceDespesa (Zaya.js) —
// não é exaustivo, o Groq deve inferir casos parecidos pelo contexto.
const PALAVRAS_INFORMAIS = {
    'Café da Manhã': ['pão', 'café', 'iogurte', 'fruta', 'suco', 'biscoito', 'tapioca', 'cuscuz', 'leite', 'achocolatado', 'mingau', 'bolo de café', 'croissant', 'pão de queijo'],
    'Lanche': ['lanche', 'salgado', 'pastel', 'coxinha', 'esfiha', 'hambúrguer', 'pizza', 'sanduíche', 'açaí', 'sorvete', 'pipoca', 'barra de cereal', 'snack', 'bolinho'],
    'Almoço': ['almoço', 'marmita', 'restaurante', 'self-service', 'prato feito', 'pf', 'comida', 'arroz e feijão', 'buffet'],
    'Jantar': ['jantar', 'janta', 'comida à noite', 'delivery à noite', 'ifood à noite', 'ifood', 'rappi', 'delivery'],
    'Mercado': ['mercado', 'supermercado', 'feira', 'hortifruti', 'açougue', 'padaria', 'sacolão'],
    'Academia': ['academia', 'mensalidade academia', 'gym', 'personal'],
    'Metrô': ['metrô', 'metro', 'bilhete único', 'cartão transporte'],
    'Ônibus': ['ônibus', 'onibus', 'busão'],
    '99': ['99', 'noventa e nove', 'corrida 99'],
    'Uber': ['uber', 'corrida', 'aplicativo de transporte'],
    'Aluguel': ['aluguel', 'alug'],
    'Internet': ['internet', 'wi-fi', 'wifi', 'banda larga', 'fibra'],
    'Água': ['água', 'conta de água', 'sabesp', 'embasa'],
    'Luz': ['luz', 'energia', 'conta de luz', 'enel', 'cemig'],
    'Gás': ['gás', 'botijão', 'botijão de gás', 'gás de cozinha'],
    'Farmácia': ['remédio', 'medicamento', 'farmácia', 'drogaria', 'comprimido', 'pomada', 'vitamina'],
    'Lavanderia': ['lavanderia', 'lavandaria', 'lavar roupa'],
    'Corte de Cabelo': ['cabelo', 'barbearia', 'barba', 'corte'],
    'Produtos': ['shampoo', 'condicionador', 'sabonete', 'desodorante', 'creme', 'maquiagem', 'perfume', 'hidratante'],
    'Ração': ['ração', 'petshop', 'pet shop', 'veterinário', 'vacina pet'],
    'Viagem': ['viagem', 'passagem', 'hotel', 'hospedagem', 'airbnb', 'passeio'],
    'Vestuário': ['roupa', 'camiseta', 'calça', 'tênis', 'sapato', 'meia', 'cueca', 'sutiã', 'vestido', 'blusa'],
    'Emergência': ['emergência', 'imprevisto', 'urgência'],
    'Dízimo': ['dízimo', 'dizimo', 'oferta', 'igreja'],
}

// Emoji fixo por subcategoria/categoria (usado nas mensagens de confirmação)
const EMOJIS = {
    'Lanche': '🥪', 'Almoço': '🍽️', 'Café da Manhã': '☕', 'Jantar': '🌙',
    'Mercado': '🛒', 'Academia': '💪',
    'Metrô': '🚇', 'Ônibus': '🚌', '99': '🚖', 'Uber': '🚗',
    'Aluguel': '🏠', 'Internet': '📶', 'Água': '💧', 'Luz': '💡', 'Gás': '🔥',
    'Farmácia': '💊', 'Lavanderia': '👕', 'Corte de Cabelo': '💈', 'Produtos': '🧴',
    'Ração': '🐾', 'Animal de Estimação': '🐾',
    'Viagem': '✈️', 'Lazer': '✈️',
    'Vestuário': '👔', 'Emergência': '🚨', 'Dízimo': '🙏', 'Outros': '📦',
    'Renda Extra': '💰', 'Salário': '💼', 'Vale-Alimentação': '🍱', 'Vale-Transporte': '🚍',
    // categorias-pai sem emoji específico listado — usadas quando não há subcategoria
    'Alimentação': '🍽️', 'Transporte': '🚌', 'Casa': '🏠', 'Cuidados Pessoais': '🧴',
}
function emojiPara(categoria, subcategoria) {
    return EMOJIS[subcategoria] || EMOJIS[categoria] || '📦'
}

// Descrição legível das categorias/subcategorias para o prompt do Groq
function descreverCategorias() {
    const linhas = []
    for (const [cat, info] of Object.entries(PLANEJAMENTO)) {
        const subs = Object.keys(info.subs)
        linhas.push(subs.length ? `- ${cat}: ${subs.join(', ')}` : `- ${cat} (sem subcategoria)`)
    }
    return linhas.join('\n')
}

function descreverPalavrasInformais() {
    return Object.entries(PALAVRAS_INFORMAIS)
        .map(([sub, palavras]) => `- ${sub}: ${palavras.join(', ')}`)
        .join('\n')
}

// ───────────────────────── Utilidades ─────────────────────────

const esperar = ms => new Promise(r => setTimeout(r, ms))

function dataParaBR(dataISO) {
    const [ano, mes, dia] = dataISO.split('-')
    return `${dia}/${mes}/${ano}`
}

// Data de hoje no fuso de São Paulo, em AAAA-MM-DD.
// NUNCA usar new Date().toISOString() aqui — ela usa UTC, e à noite no Brasil (UTC-3)
// isso "pula" pro dia seguinte (ex: 21h30 em SP = 00h30 UTC do dia seguinte), causando
// lançamentos com a data errada.
function hojeBR() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}

function formatarBR(n) {
    return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Extrai o primeiro valor monetário BR de um texto (ex: "R$ 1.234,56" → 1234.56)
function primeiroValorMoeda(texto) {
    const m = [...texto.matchAll(/R?\$?\s*([\d.]{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/g)]
        .map(x => Number(x[1].replace(/\./g, '').replace(',', '.')))
        .filter(Number.isFinite)
    return m.length ? m[0] : null
}

// Resolve o nome canônico de categoria/subcategoria ignorando caixa e acentos leves
function casarNome(entrada, opcoes) {
    if (!entrada) return null
    const norm = s => s.toString().trim().toLowerCase()
    const alvo = norm(entrada)
    return opcoes.find(o => norm(o) === alvo) || null
}

// ───────────────────────── Interpretação via Groq ─────────────────────────

const PROMPT_DESPESA = `Você interpreta mensagens em texto livre do dono de uma loja, que registra gastos e receitas pessoais pelo WhatsApp.
Extraia os dados da despesa ou receita mencionada.

A mensagem raramente vem em formato formal. NÃO exija palavras como "gastei" ou "paguei" — trate QUALQUER
mensagem que combine um valor monetário com algo que pareça um item/categoria de gasto como uma despesa.
Exemplos válidos, todos devem ser interpretados corretamente:
"2 em lanche", "2$ em lanche", "R$2 lanche", "2 reais pão", "12,82 alimentação", "academia 139,90", "gastei 50 no mercado".

CATEGORIAS E SUBCATEGORIAS DE DESPESA VÁLIDAS (use EXATAMENTE estes nomes):
${descreverCategorias()}

Categorias de RECEITA válidas (só se a mensagem for claramente um recebimento, ex: "recebi 3000 de salário", "recebi 200 vale-alimentação"): ${RECEITAS.join(', ')}

GUIA DE PALAVRAS INFORMAIS → SUBCATEGORIA (use como referência para mapear o item citado; esta lista NÃO é
exaustiva — infira outros casos parecidos pelo contexto, mesmo que a palavra exata não esteja aqui):
${descreverPalavrasInformais()}

REGRAS:
- valor: número decimal com ponto (ex: 12.82). Aceite vírgula, ponto, "R$", "$" ou "reais" na entrada.
- categoria: escolha EXATAMENTE uma da lista acima. Se a palavra citada for uma subcategoria ou um item informal do guia (ex: "pão", "uber", "shampoo"), deduza a categoria pai correta.
- subcategoria: preencha SOMENTE se a categoria tiver subcategorias e você identificar qual. Caso contrário, "".
- data: AAAA-MM-DD. Use a data de hoje informada se não houver outra data clara.
- confianca: número de 0 a 1 indicando o quão seguro você está da categoria/subcategoria escolhida. Use < 0.6
  se o item mencionado não se encaixar claramente em nenhuma subcategoria (do guia ou por inferência razoável),
  ou se houver ambiguidade real entre duas categorias possíveis.
- status: "Pendente" se a mensagem indicar que a conta AINDA NÃO foi paga (ex: "pendente", "a pagar", "vence",
  "venceu", "atrasada"); "Concluído" se indicar que já foi paga (ex: "paguei", "quitei", "já paguei", "pago") ou
  se não houver nenhuma indicação clara — "Concluído" é o padrão.
- cartao: nome de quem é o cartão de crédito ou identificação do cartão, SOMENTE se a mensagem mencionar isso
  explicitamente (ex: "cartão do Thiago", "cartão de crédito do Thiago Santana", "no cartão Nubank"). Extraia só o
  nome/identificação (ex: "Thiago Santana", "Nubank"), sem a palavra "cartão". Caso não seja mencionado, "".

Responda EXCLUSIVAMENTE em JSON, sem texto fora do JSON:
{"valor": 0.00, "categoria": "...", "subcategoria": "...", "data": "AAAA-MM-DD", "confianca": 0.0, "status": "Concluído", "cartao": ""}`

// Retorna { ok, dados?, motivo? }. dados = { valor, categoria, subcategoria, descricao, data, status, confianca }
async function interpretarDespesa(texto) {
    const hoje = hojeBR()
    let bruto
    try {
        const resp = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            max_tokens: 400,
            temperature: 0.1,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: `${PROMPT_DESPESA}\n\nData de hoje: ${hoje}` },
                { role: 'user', content: texto },
            ],
        })
        bruto = JSON.parse(resp.choices[0].message.content)
    } catch (err) {
        return { ok: false, motivo: `Não consegui interpretar a mensagem (${err.message}).` }
    }

    const valor = Number(String(bruto.valor).replace(',', '.'))
    if (!Number.isFinite(valor) || valor <= 0) {
        return { ok: false, motivo: 'Não identifiquei um valor válido na mensagem.' }
    }

    // Normaliza categoria contra a lista canônica (despesa ou receita)
    const todas = [...CATEGORIAS_DESPESA, ...RECEITAS]
    const categoria = casarNome(bruto.categoria, todas)
    if (!categoria) {
        return { ok: false, motivo: `Não reconheci a categoria "${bruto.categoria}".`, precisaConfirmar: true }
    }

    // Normaliza subcategoria (se a categoria tiver subs)
    let subcategoria = ''
    const subsValidas = PLANEJAMENTO[categoria] ? Object.keys(PLANEJAMENTO[categoria].subs) : []
    if (bruto.subcategoria) {
        subcategoria = casarNome(bruto.subcategoria, subsValidas) || ''
    }
    // Categorias "catch-all" com subcategoria homônima (ex: Outros/Outros) — o site exige uma
    // subcategoria selecionada quando a categoria tem opções, então usa a própria categoria.
    if (!subcategoria && subsValidas.includes(categoria)) {
        subcategoria = categoria
    }

    const confianca = Number(bruto.confianca)
    // data: sempre AAAA-MM-DD (formato exigido pelo <input type=date> do site) — o Groq deve
    // devolver a data de hoje informada no prompt quando a mensagem não menciona outra data.
    const data = /^\d{4}-\d{2}-\d{2}$/.test(bruto.data || '') ? bruto.data : hoje
    // Descrição SEMPRE é o nome da subcategoria (ou categoria, se não houver subcategoria) —
    // nunca texto livre do Groq ou do dono.
    const descricao = subcategoria || categoria

    const status = bruto.status === 'Pendente' ? 'Pendente' : 'Concluído'
    const cartao = typeof bruto.cartao === 'string' ? bruto.cartao.trim() : ''

    const dados = { valor, categoria, subcategoria, descricao, data, status, cartao, confianca: Number.isFinite(confianca) ? confianca : 0.5 }

    if (dados.confianca < 0.6) {
        return { ok: false, precisaConfirmar: true, dados, motivo: `Fiquei em dúvida se é *${categoria}*${subcategoria ? ` / ${subcategoria}` : ''}.` }
    }

    return { ok: true, dados }
}

// ───────────────────────── Browser persistente ─────────────────────────

let plannerBrowser = null
let plannerPage = null
let ocupado = false // mutex: um cadastro por vez sobre a página compartilhada

async function abrirPlannerBrowser() {
    if (plannerBrowser && plannerBrowser.isConnected() && plannerPage && !plannerPage.isClosed()) {
        return { browser: plannerBrowser, page: plannerPage }
    }

    // Estado inconsistente — limpa antes de reabrir
    if (plannerBrowser) { try { await plannerBrowser.close() } catch {} }
    plannerBrowser = null
    plannerPage = null

    const chromePath = resolverChrome()
    console.log(`🌐 [Planner] Abrindo navegador — path: ${chromePath}`)
    plannerBrowser = await rawPuppeteer.launch({
        headless: false,
        executablePath: chromePath,
        userDataDir: PROFILE_DIR,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--window-size=1366,768',
            '--lang=pt-BR',
        ],
    })

    plannerBrowser.on('disconnected', () => {
        console.log('⚠️  [Planner] Navegador fechou — será reaberto no próximo lançamento.')
        plannerBrowser = null
        plannerPage = null
    })

    const paginas = await plannerBrowser.pages()
    plannerPage = paginas[0] || await plannerBrowser.newPage()
    await plannerPage.setViewport({ width: 1366, height: 768 })
    await plannerPage.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' })

    return { browser: plannerBrowser, page: plannerPage }
}

// Fecha modais promocionais (DaisyUI modal-box). Usa ElementHandle.click() (CDP) para
// garantir que handlers React disparem. NÃO pressiona Escape sem motivo — alguns SPAs
// usam Escape para navegação, causando redirect indesejado.
async function fecharModaisPromocionais(page) {
    await esperar(600)
    let fechouAlgo = false
    for (let i = 0; i < 4; i++) {
        // Site usa <dialog open> nativo (DaisyUI 5) — elementos dentro dele têm
        // offsetParent null (top layer), por isso NÃO filtrar por offsetParent aqui.
        // Fallback: [class*="modal-box"] com tamanho real, para modais antigos em <div>.
        const elHandle = await page.evaluateHandle(() => {
            const modalBox = document.querySelector('dialog[open] [class*="modal-box"], dialog[open]')
                || [...document.querySelectorAll('[class*="modal-box"]')].find(el => {
                    const rect = el.getBoundingClientRect()
                    return rect.height > 50 && rect.width > 100
                })
            if (!modalBox) return null
            return [...modalBox.querySelectorAll('button')]
                .find(el => /^[✕✖×x]$/i.test((el.textContent || '').trim()) || /btn-circle/i.test(String(el.className || ''))) || null
        }).catch(() => null)
        const elBtn = elHandle?.asElement ? elHandle.asElement() : null
        if (!elBtn) break
        await elBtn.click()
        fechouAlgo = true
        await esperar(600)
    }
    // Escape só quando algo foi fechado (limpa possíveis sub-modais)
    if (fechouAlgo) {
        await page.keyboard.press('Escape').catch(() => {})
        await esperar(300)
    }
}

// Detecta se a página está pedindo login aguardando o SPA montar.
// Promise.race: quem aparecer primeiro — campo de senha (login) ou elemento do app (logado).
// Timeout de 10s → fallback pela URL (evita falso-positivo com React ainda carregando).
async function precisaLogin(page) {
    try {
        const SEL_LOGIN = 'input[type="password"]'
        const SEL_APP   = 'table, nav, [class*="sidebar" i], [class*="menu" i], [class*="layout" i]'
        // visible: true é essencial — sem isso, waitForSelector resolve assim que o elemento
        // existe no DOM (mesmo oculto), e um <input type="password"> escondido em algum canto
        // da página logada (ex: formulário de troca de senha) gera falso positivo de "precisa login".
        const resultado = await Promise.race([
            page.waitForSelector(SEL_LOGIN, { visible: true, timeout: 10000 }).then(() => true),
            page.waitForSelector(SEL_APP,   { visible: true, timeout: 10000 }).then(() => false),
        ]).catch(() => /\/login|\/entrar|\/signin/i.test(page.url()))
        return resultado
    } catch { return true }
}

// Garante que a sessão está logada. Faz login automático com credenciais do .env
// se a sessão tiver expirado. onStatus notifica o dono pelo WhatsApp.
async function garantirLogado(page, onStatus) {
    // Navega para lançamentos com networkidle2 (React carregado + possíveis redirects resolvidos)
    if (!page.url().includes('/controle/lancamentos')) {
        await page.goto(LANCAMENTOS_URL, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {})
    }
    await fecharModaisPromocionais(page)
    console.log(`📍 [Planner] URL pós-navegação: ${page.url()}`)

    if (!(await precisaLogin(page))) {
        console.log('✅ [Planner] Sessão ativa')
        return
    }

    // Sessão expirou — tenta login automático com credenciais do .env
    const email = process.env.PLANNER_EMAIL
    const senha = process.env.PLANNER_PASSWORD
    if (email && senha) {
        console.log('🔑 [Planner] Sessão expirada — fazendo login automático...')
        if (onStatus) onStatus('🔑 Sessão do Planner expirada — fazendo login automático...')

        if (!page.url().includes('/login')) {
            await page.goto(PLANNER_URL, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {})
        }
        await page.waitForSelector('input[type="password"]', { timeout: 10000 }).catch(() => {})

        // Preenche usando setter nativo do React (controlled inputs)
        const setReact = async (seletor, valor) => {
            await page.evaluate((sel, val) => {
                const el = document.querySelector(sel)
                if (!el) throw new Error(`Seletor não encontrado: ${sel}`)
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
                if (setter) setter.call(el, val); else el.value = val
                el.dispatchEvent(new Event('input', { bubbles: true }))
                el.dispatchEvent(new Event('change', { bubbles: true }))
            }, seletor, valor)
        }

        await setReact('input[type="email"], input[name="email"]', email)
        await esperar(200)
        await setReact('input[type="password"]', senha)
        await esperar(300)

        // Clica no botão de entrar via ElementHandle (CDP — dispara handlers React)
        // IMPORTANTE: filtrar por offsetParent !== null — pode haver button[type=submit]
        // oculto antes do formulário de login no DOM, causando "Node is either not clickable"
        const elSubmitHandle = await page.evaluateHandle(() => {
            const visiveis = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null)
            return visiveis.find(b => b.type === 'submit')
                || visiveis.find(b => /entrar|login|acessar/i.test((b.textContent || '').trim()))
                || null
        })
        const elSubmit = elSubmitHandle?.asElement ? elSubmitHandle.asElement() : null
        if (!elSubmit) {
            await page.screenshot({ path: path.join(DEBUG_DIR, 'login_botao_nao_encontrado.png') }).catch(() => {})
            throw new Error('Botão de login não encontrado na tela de login')
        }
        await elSubmit.click()

        // Aguarda URL sair de /login
        await page.waitForFunction(
            () => !window.location.href.includes('/login'),
            { timeout: 15000 }
        ).catch(() => {})
        await esperar(1500)
        await fecharModaisPromocionais(page)

        if (await precisaLogin(page)) throw new Error('Login automático falhou — verifique PLANNER_EMAIL e PLANNER_PASSWORD no .env')

        console.log('✅ [Planner] Login automático concluído')
        if (onStatus) onStatus('✅ Login automático no Planner concluído — cadastrando despesa...')
    } else {
        // Sem credenciais → login manual (fallback)
        await page.goto(PLANNER_URL, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {})
        console.log('⏸️  [Planner] Tela de login — aguardando login manual (até 5 min)...')
        if (onStatus) onStatus('🔐 Abri o navegador do Planner na tela de login. Faça o login manualmente — assim que entrar, eu continuo o cadastro. (aguardo até 5 min)')

        const inicio = Date.now()
        while (Date.now() - inicio < TIMEOUT_LOGIN_MS) {
            await esperar(3000)
            if (!(await precisaLogin(page))) break
        }
        if (await precisaLogin(page)) throw new Error('LOGIN_TIMEOUT')
        console.log('✅ [Planner] Login manual concluído.')
        await esperar(1500)
        await fecharModaisPromocionais(page)
    }

    // Após login (auto ou manual): navega para lançamentos e lida com Application error
    await page.goto(LANCAMENTOS_URL, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {})
    await esperar(1500)
    const temErro = await page.evaluate(() =>
        /application error|client.side exception/i.test(document.body?.innerText || '')
    ).catch(() => false)
    if (temErro) {
        console.log('⚠️  [Planner] Application error pós-login — recarregando...')
        await page.reload({ waitUntil: 'networkidle2', timeout: 40000 })
        await esperar(1500)
    }
    await fecharModaisPromocionais(page)
}

// ───────────────────────── Fluxo de cadastro (seletores validados no finn.js) ─────────────────────────

// Localiza o botão "+" via evaluateHandle (retorna ElementHandle para click via CDP)
async function encontrarBotaoNovo(page) {
    return page.evaluateHandle(() => {
        // Tenta 0: id estável do botão "Criar lançamento" (confirmado via inspeção ao vivo em 2026-07-11)
        const porId = document.getElementById('create-transaction-btn')
        if (porId && porId.offsetParent !== null) return porId

        const cands = [...document.querySelectorAll('button, a, [role="button"]')]
            .filter(el => el.offsetParent !== null)
        const txt = el => (el.textContent || '').trim()
        // Tenta 1: botão com texto "+"
        let alvo = cands.find(b => /^[+＋]$/.test(txt(b)))
        // Tenta 2: aria-label com add/plus/novo
        if (!alvo) alvo = cands.find(b => /add|plus|novo|criar|adicionar/i.test(b.getAttribute('aria-label') || ''))
        // Tenta 3: SVG com padrão de + (linha vertical ML + horizontal H)
        // NOTA: /H/ (não /\bH\b/) — em "7.41016H12.53" não há word boundary entre dígito e H
        if (!alvo) {
            alvo = cands.find(b => {
                const svg = b.querySelector('svg')
                if (!svg) return false
                const paths = [...svg.querySelectorAll('path, line')]
                if (paths.length < 2 || paths.length > 4) return false
                const ds = paths.map(p => (p.getAttribute('d') || '').trim())
                return ds.some(d => /H/.test(d)) && ds.some(d => /^M[\d.]+\s+[\d.]+L[\d.]+\s+[\d.]+$/.test(d))
            })
        }
        // Tenta 4: btn-sm pequeno na toolbar (sidebar pode estar expandida)
        if (!alvo) {
            alvo = [...document.querySelectorAll('button.btn-sm')]
                .find(el => {
                    if (!el.offsetParent) return false
                    const r = el.getBoundingClientRect()
                    return r.y > 80 && r.y < 200 && r.width < 60
                }) || null
        }
        return alvo || null
    })
}

async function abrirNovoLancamento(page) {
    // Navega para lançamentos só se não estiver lá (evita reload duplo)
    if (!page.url().includes('/controle/lancamentos')) {
        await page.goto(LANCAMENTOS_URL, { waitUntil: 'networkidle2', timeout: 40000 })
        await esperar(2000)
    }

    // Trata Application error (Next.js) — até 3 tentativas de reload
    for (let t = 0; t < 3; t++) {
        const temErro = await page.evaluate(() =>
            /application error|client.side exception/i.test(document.body?.innerText || '')
        ).catch(() => false)
        if (!temErro) break
        console.log(`⚠️  [Planner] Application error (tentativa ${t + 1}) — recarregando...`)
        await page.reload({ waitUntil: 'networkidle2', timeout: 40000 })
        await esperar(2000)
    }

    await fecharModaisPromocionais(page)
    await page.screenshot({ path: path.join(DEBUG_DIR, 'antes_clicar_novo.png') }).catch(() => {})
    console.log(`📍 [Planner] URL em abrirNovoLancamento: ${page.url()}`)

    // Tenta clicar no "+" até 3 vezes, aguardando a linha inline aparecer.
    // NOTA (2026-07-11): confirmado ao vivo que a Conta de Maurício (a usada pela Zaya)
    // ainda abre uma LINHA INLINE na tabela — não o modal "Inserir um Lançamento" que
    // outras contas do site já têm (ex: conta da loja). Não assumir o modal aqui.
    let linhaAbriu = false
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
        const elPlusHandle = await encontrarBotaoNovo(page)
        const elPlus = elPlusHandle?.asElement ? elPlusHandle.asElement() : null

        if (!elPlus) {
            if (tentativa < 3) {
                console.log(`⚠️  [Planner] "+" não encontrado (tentativa ${tentativa}) — aguardando...`)
                await esperar(2000)
                continue
            }
            await page.screenshot({ path: path.join(DEBUG_DIR, 'botao_novo_nao_encontrado.png') }).catch(() => {})
            const visiveis = await page.evaluate(() =>
                [...document.querySelectorAll('button')].filter(el => el.offsetParent !== null)
                    .slice(0, 15).map(b => (b.textContent || '').trim() || '[SVG]')
            ).catch(() => [])
            console.log(`🔍 [Planner] Botões visíveis: ${JSON.stringify(visiveis)}`)
            throw new Error('Botão "+" de novo lançamento não encontrado após 3 tentativas')
        }

        console.log(`🖱️  [Planner] Clicando "+" via ElementHandle (tentativa ${tentativa})`)
        await elPlus.click()
        await page.screenshot({ path: path.join(DEBUG_DIR, 'apos_clicar_novo.png') }).catch(() => {})

        // Aguarda linha inline (input[type="date"] DENTRO de TR — exclui filtros do toolbar)
        const apareceu = await page.waitForFunction(
            () => [...document.querySelectorAll('tr input[type="date"]')].some(el => el.offsetParent !== null),
            { timeout: 8000 }
        ).then(() => true).catch(() => false)

        if (apareceu) {
            console.log('✅ [Planner] Linha inline aberta')
            linhaAbriu = true
            break
        }

        console.log(`⚠️  [Planner] Linha não apareceu após tentativa ${tentativa}`)
        if (tentativa === 3) {
            await page.screenshot({ path: path.join(DEBUG_DIR, 'linha_nao_abriu.png') }).catch(() => {})
        }
        await esperar(1000)
    }

    if (!linhaAbriu) {
        throw new Error('Linha inline de lançamento não abriu após clicar em "+" (veja debug_planner/linha_nao_abriu.png)')
    }

    await esperar(500)
}

async function preencherLinhaLancamento(page, dados) {
    // O TR da linha inline tem input[type="date"] — sobe 3 níveis: input > label > td > tr
    // Usa "tr input" para excluir os 3 inputs de filtro fora da tabela
    const elLinha = await page.evaluateHandle(() => {
        const dateInp = [...document.querySelectorAll('tr input[type="date"]')]
            .find(el => el.offsetParent !== null)
        return dateInp?.parentElement?.parentElement?.parentElement || null
    })
    const elLinhaEl = elLinha?.asElement ? elLinha.asElement() : null
    if (!elLinhaEl) {
        await page.screenshot({ path: path.join(DEBUG_DIR, 'linha_nao_encontrada.png') }).catch(() => {})
        throw new Error('Linha inline de lançamento não encontrada (veja debug_planner/linha_nao_encontrada.png)')
    }
    const celulas = await elLinhaEl.$$(':scope > td')
    if (celulas.length < 10) {
        await page.screenshot({ path: path.join(DEBUG_DIR, 'linha_celulas_insuficientes.png') }).catch(() => {})
        throw new Error(`Linha com apenas ${celulas.length} célula(s) — esperado ≥ 10`)
    }

    // Para inputs React: usa o setter nativo para disparar eventos corretamente
    async function setarInput(celula, valor) {
        const input = await celula.$('input')
        if (!input) throw new Error('Input não encontrado na célula')
        await page.evaluate((el, val) => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
            if (setter) setter.call(el, val); else el.value = val
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
        }, input, String(valor))
    }

    async function selecionar(celula, textoOpcao) {
        const select = await celula.$('select')
        if (!select) throw new Error('Select não encontrado na célula')
        const ok = await page.evaluate((el, texto) => {
            const opt = [...el.options].find(o => o.textContent.trim().toLowerCase() === texto.toLowerCase())
            if (!opt) return false
            el.value = opt.value
            el.dispatchEvent(new Event('change', { bubbles: true }))
            return true
        }, select, textoOpcao)
        if (!ok) throw new Error(`Opção "${textoOpcao}" não encontrada no <select>`)
    }

    // td[0]=checkbox, td[1]=data evento, td[2]=data efetivação, td[3]=categoria,
    // td[4]=subcategoria, td[5]=inst.financeira(skip), td[6]=cartão,
    // td[7]=descrição, td[8]=valor, td[9]=status, td[10]=botões
    await setarInput(celulas[1], dados.data)   // input[type="date"] — formato YYYY-MM-DD
    await esperar(200)
    await setarInput(celulas[2], dados.data)
    await esperar(200)
    await selecionar(celulas[3], dados.categoria)
    await esperar(1000)  // React precisa atualizar as subcategorias
    if (dados.subcategoria) {
        try { await selecionar(celulas[4], dados.subcategoria) } catch (e) {
            console.log(`⚠️  [Planner] Subcategoria "${dados.subcategoria}" não selecionada: ${e.message}`)
        }
        await esperar(300)
    } else {
        // Se o <select> de subcategoria tem opções reais (além do placeholder), o site exige
        // uma escolha — sem isso o formulário fica preso em edição e o salvamento falha em
        // silêncio (looks like sucesso, mas nada é gravado). Falha aqui com erro explícito.
        const exigeSubcategoria = await page.evaluate(el => {
            const select = el.querySelector('select')
            return !!select && [...select.options].some(o => o.value)
        }, celulas[4])
        if (exigeSubcategoria) {
            await page.screenshot({ path: path.join(DEBUG_DIR, 'subcategoria_obrigatoria_faltando.png') }).catch(() => {})
            throw new Error(`Categoria "${dados.categoria}" exige uma subcategoria e nenhuma foi identificada`)
        }
    }
    if (dados.cartao) {
        // Célula 6 (cartão) pode ser <select> (cartões já cadastrados no site) ou <input>
        // livre, dependendo da conta — tenta select primeiro (match exato, case-insensitive),
        // cai pro input se não houver select ou a opção não existir. Nunca crítico: se nenhum
        // dos dois funcionar, só avisa e segue o lançamento sem travar por causa desse campo.
        try {
            await selecionar(celulas[6], dados.cartao)
        } catch (e) {
            try {
                await setarInput(celulas[6], dados.cartao)
            } catch (e2) {
                console.log(`⚠️  [Planner] Cartão "${dados.cartao}" não preenchido: ${e2.message}`)
            }
        }
        await esperar(200)
    }
    await setarInput(celulas[7], dados.descricao)
    await esperar(200)
    await setarInput(celulas[8], String(dados.valor.toFixed(2)).replace('.', ','))
    await esperar(200)
    try { await selecionar(celulas[9], dados.status || 'Concluído') } catch (e) {
        console.log(`⚠️  [Planner] Status "${dados.status || 'Concluído'}" não selecionado: ${e.message}`)
    }
    await page.screenshot({ path: path.join(DEBUG_DIR, 'linha_preenchida.png') }).catch(() => {})
}

async function salvarLancamento(page) {
    // Localiza button[type="submit"] dentro do TR de edição via ElementHandle (CDP)
    // para garantir que handlers React do formulário disparem corretamente
    const elSubmitHandle = await page.evaluateHandle(() => {
        const dateInp = [...document.querySelectorAll('tr input[type="date"]')]
            .find(el => el.offsetParent !== null)
        const tr = dateInp?.parentElement?.parentElement?.parentElement
        if (!tr) return null
        return [...tr.querySelectorAll('button')].find(b => b.type === 'submit') || null
    })
    const elSubmit = elSubmitHandle?.asElement ? elSubmitHandle.asElement() : null
    if (!elSubmit) {
        await page.screenshot({ path: path.join(DEBUG_DIR, 'botao_salvar_nao_encontrado.png') }).catch(() => {})
        throw new Error('Botão submit de salvar não encontrado (veja debug_planner/botao_salvar_nao_encontrado.png)')
    }
    await elSubmit.click()
    await esperar(3000)
    await page.screenshot({ path: path.join(DEBUG_DIR, 'apos_salvar.png') }).catch(() => {})

    const sucesso = await page.evaluate(() => {
        const t = (document.body?.innerText || '').toLowerCase()
        return /lançamento (criado|salvo|adicionado)|criado com sucesso|salvo com sucesso/.test(t)
    }).catch(() => false)
    return sucesso
}

// Lê a seção "DESPESAS: REALIZADO VS PLANEJADO" do Balanço Mensal e retorna o mapa completo
// { categoria_minuscula: valorRealizado }, usado tanto pra categoria do lançamento atual quanto
// pra sugerir categorias com folga no insight de estouro (precisa comparar TODAS as categorias).
async function lerBalancoMensalCompleto(page) {
    await page.goto(BALANCO_MENSAL_URL, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {})
    await esperar(3000)
    await fecharModaisPromocionais(page)
    await page.screenshot({ path: path.join(DEBUG_DIR, 'balanco_mensal.png') }).catch(() => {})

    // Formato: CATEGORIA\nX.X%\nR$ Y,YY (repetido para cada categoria)
    return page.evaluate(() => {
        const txt = document.body.innerText || ''
        const inicio = txt.indexOf('DESPESAS: REALIZADO VS PLANEJADO')
        const fim = txt.indexOf('GASTOS COM', inicio)
        if (inicio < 0) return {}
        const bloco = txt.substring(inicio + 'DESPESAS: REALIZADO VS PLANEJADO'.length, fim > 0 ? fim : undefined)
        const linhas = bloco.split('\n').map(l => l.trim()).filter(Boolean)
        const resultado = {}
        for (let i = 0; i < linhas.length; i++) {
            const l = linhas[i]
            if (/^\d+[,.]?\d*%$/.test(l)) continue
            if (/^R\$/.test(l)) continue
            // Linha de categoria: próxima deve ser percentual e a seguinte o valor
            if (i + 2 < linhas.length && /^\d+[,.]?\d*%$/.test(linhas[i + 1])) {
                const vStr = (linhas[i + 2] || '').replace('R$', '').trim()
                    .replace(/\./g, '').replace(',', '.')
                resultado[l.toLowerCase()] = parseFloat(vStr) || 0
            }
        }
        return resultado
    })
}

// Lê /controle/pendencias e retorna só as pendências com vencimento HOJE ou ANTERIOR (atrasadas
// até hoje) — cada item como { data, dataCurta, valor, nomeItem, textoCompleto }.
// IMPORTANTE: nomeItem vem da célula real da linha (não de um "achismo" comparando o texto
// contra a lista de categorias conhecidas — isso dava "Outros" pra qualquer descrição/parcela
// que não batesse com nome de categoria, ex: nome de pessoa numa parcela). Cada linha é lida
// célula por célula (:scope > td); identifica a célula de data e a de valor por padrão, e usa
// a ÚLTIMA célula de texto restante (a mais perto do valor, mesma posição de subcategoria/
// descrição/cartão em /controle/lancamentos) como nomeItem — seja lá qual for o texto real ali.
async function lerPendenciasAteHoje(page) {
    await page.goto(PENDENCIAS_URL, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {})
    await esperar(3000)
    await fecharModaisPromocionais(page)
    await page.screenshot({ path: path.join(DEBUG_DIR, 'pendencias.png') }).catch(() => {})

    const linhas = await page.evaluate(() => {
        const trs = [...document.querySelectorAll('table tbody tr')]
        return trs
            .map(tr => [...tr.querySelectorAll(':scope > td')].map(td => (td.innerText || td.textContent || '').replace(/\s+/g, ' ').trim()))
            .filter(tds => tds.length >= 2)
    })

    const hoje = new Date()
    hoje.setHours(0, 0, 0, 0)
    const resultado = []
    for (const tds of linhas) {
        const dataIdx = tds.findIndex(t => /^\d{2}\/\d{2}\/\d{4}$/.test(t))
        if (dataIdx < 0) continue
        const m = tds[dataIdx].match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
        const data = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]))
        if (data > hoje) continue

        const valorIdx = tds.findIndex(t => /^R?\$?\s*[\d.]*\d,\d{2}$/.test(t))
        const valor = valorIdx >= 0 ? primeiroValorMoeda(tds[valorIdx]) : primeiroValorMoeda(tds.join(' '))

        // Células descritivas = tudo que sobrou (fora data/valor/status) e tem texto real
        // (exclui vazio/ícone e o próprio rótulo de status).
        const descritivas = tds.filter((t, i) => i !== dataIdx && i !== valorIdx
            && t.length > 1 && !/^(pendente|conclu[íi]do|atrasad[ao]|vencid[ao])$/i.test(t))
        const nomeItem = descritivas.length ? descritivas[descritivas.length - 1] : 'Outros'

        resultado.push({
            data: tds[dataIdx],
            dataCurta: `${m[1]}/${m[2]}`,
            valor,
            nomeItem,
            textoCompleto: tds.join(' '),
        })
    }
    return resultado
}

// Orquestra: abre o navegador, garante login, lê /controle/pendencias e devolve só as
// atrasadas até hoje. Usa o mesmo mutex/browser persistente das outras operações.
async function listarPendenciasAteHoje({ onStatus } = {}) {
    if (ocupado) throw new Error('Navegador do Planner ocupado com outra operação — tente de novo em instantes.')
    ocupado = true
    try {
        const { page } = await abrirPlannerBrowser()
        await garantirLogado(page, onStatus)
        return await lerPendenciasAteHoje(page)
    } finally {
        ocupado = false
    }
}

// Entre as categorias COM limite definido (exclui CATEGORIAS_SEM_LIMITE_PARA_SUGESTAO e a própria
// categoria estourada), retorna as 2 com mais saldo disponível (planejado - realizado), maior folga primeiro.
function sugerirCategoriasComFolga(realizadosTodos, categoriaEstourada) {
    return Object.entries(PLANEJAMENTO)
        .filter(([cat, info]) => info.limite != null
            && !CATEGORIAS_SEM_LIMITE_PARA_SUGESTAO.includes(cat)
            && cat !== categoriaEstourada)
        .map(([cat, info]) => ({
            categoria: cat,
            disponivel: info.limite - (realizadosTodos[cat.toLowerCase()] ?? 0),
        }))
        .filter(c => c.disponivel > 0)
        .sort((a, b) => b.disponivel - a.disponivel)
        .slice(0, 2)
}

// Varre TODAS as páginas de /controle/lancamentos somando despesas e Renda Extra do mês atual,
// agrupadas por item (subcategoria, ou categoria quando não há subcategoria). Necessário porque
// o Balanço Mensal só expõe realizado por CATEGORIA inteira (lerBalancoMensalCompleto) — não dá
// pra isolar, por exemplo, quanto de "Transporte" foi Uber/99 (não essencial) vs Metrô/Ônibus
// (essencial) sem ler os lançamentos individuais.
async function lerLancamentosDoMesAtual(page) {
    if (!page.url().includes('/controle/lancamentos')) {
        await page.goto(LANCAMENTOS_URL, { waitUntil: 'networkidle2', timeout: 40000 })
        await esperar(1500)
    }
    await fecharModaisPromocionais(page)

    const [anoAtual, mesAtual] = hojeBR().split('-')

    let totalDespesasAjustado = 0
    let receitaExtra = 0
    const porItem = {}
    // porDia: 'DD/MM/AAAA' -> total gasto naquele dia. transacoes: lista crua {data, item, valor}.
    // Alimentam os alertas proativos (gasto alto num dia, possível duplicado) — a varredura
    // da tabela já acontece pro cálculo de porItem, então agregar essas 2 dimensões a mais
    // não custa um round-trip extra ao navegador.
    const porDia = {}
    const transacoes = []
    let linhasNoMes = 0

    for (let pagina = 0; pagina < 10; pagina++) {
        const resultado = await page.evaluate((mesAtual, anoAtual, categoriasIgnorar, categoriasReceita) => {
            const linhas = [...document.querySelectorAll('tr')]
            let totalPag = 0, receitaExtraPag = 0, contagemPag = 0
            const porItemPag = {}
            const porDiaPag = {}
            const transacoesPag = []
            for (const tr of linhas) {
                const tds = [...tr.querySelectorAll(':scope > td')]
                if (tds.length < 9) continue
                const dataEvento = (tds[1]?.innerText || '').trim()
                const m = dataEvento.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
                if (!m || m[2] !== mesAtual || m[3] !== anoAtual) continue
                const categoria = (tds[3]?.innerText || '').trim()
                const subcategoria = (tds[4]?.innerText || '').trim()
                const valorMatch = (tds[8]?.innerText || '').match(/([\d.]+,\d{2})/)
                if (!valorMatch) continue
                const valor = parseFloat(valorMatch[1].replace(/\./g, '').replace(',', '.'))
                if (!Number.isFinite(valor)) continue
                contagemPag++

                if (categoria === 'Renda Extra') { receitaExtraPag += valor; continue }
                if (categoriasReceita.includes(categoria)) continue // Salário/VA/VT: já embutidos na receita base fixa
                if (categoriasIgnorar.includes(categoria)) continue // pagas pela loja

                totalPag += valor
                const item = subcategoria || categoria
                porItemPag[item] = (porItemPag[item] || 0) + valor
                porDiaPag[dataEvento] = (porDiaPag[dataEvento] || 0) + valor
                transacoesPag.push({ data: dataEvento, item, valor })
            }
            return { totalPag, receitaExtraPag, porItemPag, porDiaPag, transacoesPag, contagemPag }
        }, mesAtual, anoAtual, CATEGORIAS_IGNORAR_RESUMO, RECEITAS)

        totalDespesasAjustado += resultado.totalPag
        receitaExtra += resultado.receitaExtraPag
        linhasNoMes += resultado.contagemPag
        for (const [item, valor] of Object.entries(resultado.porItemPag)) {
            porItem[item] = (porItem[item] || 0) + valor
        }
        for (const [data, valor] of Object.entries(resultado.porDiaPag)) {
            porDia[data] = (porDia[data] || 0) + valor
        }
        transacoes.push(...resultado.transacoesPag)

        const avancou = await page.evaluate(() => {
            const paginaEl = [...document.querySelectorAll('*')]
                .find(e => e.children.length === 0 && /^Página \d+\/\d+$/.test((e.textContent || '').trim()))
            if (!paginaEl) return false
            const [, atual, total] = paginaEl.textContent.trim().match(/^Página (\d+)\/(\d+)$/) || []
            if (!atual || atual === total) return false // última página
            let container = paginaEl.closest('div')
            for (let up = 0; up < 4 && container; up++) {
                const btns = [...container.querySelectorAll('button')].filter(b => b.offsetParent !== null)
                if (btns.length >= 2) {
                    const proximo = btns[btns.length - 1]
                    if (proximo.disabled) return false
                    proximo.click()
                    return true
                }
                container = container.parentElement
            }
            return false
        })
        if (!avancou) break
        await esperar(1200)
    }

    if (linhasNoMes === 0) {
        console.log('⚠️  [Planner] Nenhum lançamento do mês atual encontrado — verifique se o filtro de datas da tabela cobre o mês corrente')
    }

    return { totalDespesasAjustado, receitaExtra, porItem, porDia, transacoes }
}

function classificarItem(item) {
    if (CATEGORIAS_NAO_ESSENCIAIS.includes(item)) return 'nao-essencial'
    if (CATEGORIAS_SEMI_ESSENCIAIS.includes(item)) return 'semi-essencial'
    if (CATEGORIAS_ESSENCIAIS.includes(item)) return 'essencial'
    return null
}

// Limite planejado por item (subcategoria, ou categoria quando ela não tem subs) — achata
// PLANEJAMENTO pra granularidade de item, ignorando itens sem limite definido.
// overrides (opcional): { item: novoLimite } — usado pela revisão de planejamento da
// consultora financeira pra ajustar limites sem precisar editar PLANEJAMENTO no código.
function limitesPorItem(overrides = {}) {
    const mapa = {}
    for (const [cat, info] of Object.entries(PLANEJAMENTO)) {
        if (CATEGORIAS_IGNORAR_RESUMO.includes(cat)) continue
        const subs = Object.entries(info.subs)
        if (subs.length) {
            for (const [sub, limite] of subs) {
                if (limite != null) mapa[sub] = limite
            }
        } else if (info.limite != null) {
            mapa[cat] = info.limite
        }
    }
    return { ...mapa, ...overrides }
}

// Monta a dica do resumo diário (req. lógica da dica)
function gerarDica(porItem, saldoProjetado, receitaTotal) {
    const candidatos = Object.entries(limitesPorItem())
        .map(([item, limite]) => ({ item, disponivel: limite - (porItem[item] || 0), classe: classificarItem(item) }))
        .filter(c => c.disponivel > 0 && c.classe)

    const naoEssenciais = candidatos.filter(c => c.classe === 'nao-essencial').sort((a, b) => b.disponivel - a.disponivel)
    if (naoEssenciais.length) {
        return `Economize em ${naoEssenciais[0].item} — ainda restam R$ ${formatarBR(naoEssenciais[0].disponivel)} disponíveis.`
    }

    const semiEssenciais = candidatos.filter(c => c.classe === 'semi-essencial').sort((a, b) => b.disponivel - a.disponivel)
    if (semiEssenciais.length) {
        return `Reduza gastos em ${semiEssenciais[0].item} — ainda restam R$ ${formatarBR(semiEssenciais[0].disponivel)} disponíveis.`
    }

    if (saldoProjetado < 0) {
        return '⚠️ Atenção: no ritmo atual, você pode fechar o mês no negativo. Evite gastos não essenciais.'
    }

    if (receitaTotal > 0 && saldoProjetado > receitaTotal * 0.2) {
        return 'Você está no caminho certo! Continue registrando seus gastos para manter o controle.'
    }

    return 'Continue de olho nos gastos pra fechar o mês tranquilo.'
}

// ───────────────────────── Orquestração ─────────────────────────

// Cadastra a despesa/receita já interpretada. onStatus(msg) opcional avisa o dono pelo WhatsApp
// durante etapas longas (ex: aguardando login manual).
// Retorna: { sucesso, tipo, valorLancado, categoria, subcategoria, descricao, nomeItem,
//            planejado, realizado, percentual, restante, sugestoes }
async function cadastrarDespesa(dados, { onStatus } = {}) {
    if (ocupado) throw new Error('Já estou cadastrando outra despesa — tente de novo em instantes.')
    ocupado = true
    try {
        const { page } = await abrirPlannerBrowser()

        await garantirLogado(page, onStatus)

        await abrirNovoLancamento(page)
        await preencherLinhaLancamento(page, dados)
        const okSucesso = await salvarLancamento(page)
        console.log(`✅ [Planner] Lançado: ${dados.descricao} — R$ ${dados.valor.toFixed(2)} (${dados.categoria}${dados.subcategoria ? '/' + dados.subcategoria : ''})`)

        const tipo = RECEITAS.includes(dados.categoria) ? 'receita' : 'despesa'
        const info = PLANEJAMENTO[dados.categoria] || { limite: null, subs: {} }
        const planejadoCat = info.limite
        const planejadoSub = dados.subcategoria ? info.subs[dados.subcategoria] : null

        let realizadosTodos = {}
        try {
            realizadosTodos = await lerBalancoMensalCompleto(page)
        } catch (e) {
            console.log(`⚠️  [Planner] Não consegui ler o Balanço Mensal: ${e.message}`)
        }
        // Fallback: se o balanço não trouxe o realizado, usa ao menos o valor lançado agora
        const realizadoCat = realizadosTodos[dados.categoria.toLowerCase()] ?? dados.valor
        // Subcategoria: usa o total da categoria como proxy — o dashboard não expõe
        // realizado por subcategoria individualmente.
        const realizadoSub = realizadoCat

        // Se a subcategoria tem limite próprio, o status da mensagem é baseado nela;
        // senão cai pro limite da categoria (ou nenhum, se a categoria também não tiver).
        const usaSub = planejadoSub != null
        const planejado = usaSub ? planejadoSub : planejadoCat
        const realizado = usaSub ? realizadoSub : realizadoCat
        const percentual = (planejado && planejado > 0) ? (realizado / planejado) * 100 : null
        const restante = (planejado != null) ? (planejado - realizado) : null

        const sugestoes = (tipo === 'despesa' && percentual != null && percentual >= 100)
            ? sugerirCategoriasComFolga(realizadosTodos, dados.categoria)
            : []

        return {
            sucesso: true,
            confirmadoToast: okSucesso,
            tipo,
            valorLancado: dados.valor,
            categoria: dados.categoria,
            subcategoria: dados.subcategoria || null,
            descricao: dados.descricao,
            nomeItem: dados.subcategoria || dados.categoria,
            planejado, realizado, percentual, restante, sugestoes,
        }
    } finally {
        ocupado = false
    }
}

// Monta a mensagem de WhatsApp a partir do resultado de cadastrarDespesa (req. 7)
function formatarRespostaWhatsApp(r) {
    const emoji = emojiPara(r.categoria, r.subcategoria)
    const nomeItem = r.nomeItem

    if (r.tipo === 'receita') {
        return `✅ Receita registrada!\n\n${emoji} R$ ${formatarBR(r.valorLancado)} em ${nomeItem}\n\n💚 Lançado com sucesso no Planner.`
    }

    let msg = `✅ Despesa registrada!\n\n${emoji} R$ ${formatarBR(r.valorLancado)} em ${nomeItem}`

    if (r.planejado == null) {
        msg += `\n\n📊 Sem limite definido para ${nomeItem}.`
        return msg
    }

    const pct = r.percentual ?? 0
    const restanteExibido = formatarBR(Math.max(0, r.restante))
    let cor, texto
    if (pct < 50) {
        cor = '🟢'; texto = `Você ainda tem R$ ${restanteExibido} disponíveis em ${nomeItem}.`
    } else if (pct < 75) {
        cor = '🟡'; texto = `Atenção! Você já usou mais da metade do orçamento de ${nomeItem}. Restam R$ ${restanteExibido}.`
    } else if (pct < 90) {
        cor = '🟠'; texto = `Cuidado! O limite de ${nomeItem} está quase no fim. Restam apenas R$ ${restanteExibido}.`
    } else {
        cor = '🔴'; texto = `Limite crítico! Você está prestes a estourar o orçamento de ${nomeItem}. Restam R$ ${restanteExibido}.`
    }
    msg += `\n\n${cor} ${texto}`
    return msg
}

// Segunda mensagem separada, enviada SÓ quando o gasto ultrapassa 100% do limite (req. 8).
// Retorna null quando não se aplica.
function formatarInsightEstouro(r) {
    if (r.tipo !== 'despesa' || r.percentual == null || r.percentual < 100 || !r.sugestoes.length) return null
    const [a, b] = r.sugestoes
    let msg = `⚠️ Você estourou o orçamento de ${r.nomeItem} este mês.`
    if (a && b) {
        msg += `\n\n💡 Sugestão: tente reduzir gastos em ${a.categoria} (R$ ${formatarBR(a.disponivel)} disponíveis) ou ${b.categoria} (R$ ${formatarBR(b.disponivel)} disponíveis) para compensar.`
    } else if (a) {
        msg += `\n\n💡 Sugestão: tente reduzir gastos em ${a.categoria} (R$ ${formatarBR(a.disponivel)} disponíveis) para compensar.`
    }
    return msg
}

// Lê os lançamentos do mês atual e monta os números do resumo financeiro diário.
// onStatus(msg) opcional avisa o dono pelo WhatsApp durante etapas longas (ex: login manual).
// Lança erro se o navegador/sessão não estiver disponível — quem chama decide se pula o envio.
async function gerarResumoFinanceiroDiario({ onStatus } = {}) {
    if (ocupado) throw new Error('Navegador do Planner ocupado com outro lançamento — tente novamente mais tarde.')
    ocupado = true
    try {
        const { page } = await abrirPlannerBrowser()
        await garantirLogado(page, onStatus)

        const { receitaExtra, porItem, porDia, transacoes } = await lerLancamentosDoMesAtual(page)

        // Categorias SEM subcategoria (Mercado, Academia, Lavanderia, etc.) têm o realizado
        // substituído pelo valor real do Balanço Mensal — a soma calculada a partir dos
        // lançamentos individuais já divergiu do que o site mostra (dono reportou Mercado
        // errado 2x seguidas). Categorias COM subcategoria continuam usando a soma de
        // lançamentos, porque é a única forma de isolar cada sub (o Balanço só dá o total
        // da categoria inteira, não por subcategoria).
        let realizadosBalanco = {}
        try {
            realizadosBalanco = await lerBalancoMensalCompleto(page)
        } catch (e) {
            console.log(`⚠️  [Planner] Não consegui ler o Balanço Mensal pro resumo: ${e.message}`)
        }
        for (const [cat, info] of Object.entries(PLANEJAMENTO)) {
            if (Object.keys(info.subs).length || CATEGORIAS_IGNORAR_RESUMO.includes(cat)) continue
            const doBalanco = realizadosBalanco[cat.toLowerCase()]
            if (doBalanco != null) porItem[cat] = doBalanco
        }
        // Recalcula o total a partir do porItem já corrigido, pra ficar consistente com os
        // valores por categoria mostrados/usados (em vez do total bruto somado direto dos
        // lançamentos, que não reflete as substituições acima).
        const totalDespesasAjustado = Object.values(porItem).reduce((s, v) => s + v, 0)

        const receitaTotal = RECEITA_BASE_MENSAL + receitaExtra
        const saldoProjetado = receitaTotal - totalDespesasAjustado
        const dica = gerarDica(porItem, saldoProjetado, receitaTotal)

        // porItem/porDia/transacoes incluídos pra quem precisa do detalhamento (ex:
        // consultora-financeira.js) além do resumo pronto pro WhatsApp.
        return { totalGasto: totalDespesasAjustado, receitaTotal, saldoProjetado, dica, porItem, porDia, transacoes }
    } finally {
        ocupado = false
    }
}

// Monta a mensagem de WhatsApp do resumo financeiro diário
function formatarResumoDiario(r) {
    return `🌅 Bom dia, Maurício!\n\nEste mês você já gastou *R$ ${formatarBR(r.totalGasto)}* de *R$ ${formatarBR(r.receitaTotal)}*.\n\n📈 Projeção para o fim do mês: sobram *R$ ${formatarBR(r.saldoProjetado)}*\n\n💡 ${r.dica}`
}

module.exports = {
    interpretarDespesa,
    cadastrarDespesa,
    formatarRespostaWhatsApp,
    formatarInsightEstouro,
    gerarResumoFinanceiroDiario,
    formatarResumoDiario,
    abrirPlannerBrowser,
    PLANEJAMENTO,
    CATEGORIAS_DESPESA,
    RECEITAS,
    PALAVRAS_INFORMAIS,
    RECEITA_BASE_MENSAL,
    limitesPorItem,
    lerLancamentosDoMesAtual,
    listarPendenciasAteHoje,
    CATEGORIAS_ESSENCIAIS,
    CATEGORIAS_SEMI_ESSENCIAIS,
    CATEGORIAS_NAO_ESSENCIAIS,
    CATEGORIAS_IGNORAR_RESUMO,
    emojiPara,
}
