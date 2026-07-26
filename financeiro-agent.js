// ─────────────────────────────────────────────────────────────────────────────
// financeiro-agent.js — Lançamento automático de despesas da empresa (Zark/Ziont)
// no site https://grupoz.base44.app/financeiro, a partir de mensagens do grupo
// WhatsApp "Zark e Ziont | Financeiro".
//
// - Navegador SEMPRE visível (headless: false), perfil persistente próprio
//   (empresa_profile/ fora do repo) — NUNCA reaproveitar o profile do planner
//   pessoal ou do shopee.
// - Login MANUAL na primeira vez (sem credenciais no .env) — a sessão persiste
//   no profile entre reinícios do bot; só pede login de novo se expirar.
// - Categoria/subcategoria são validadas contra as opções REAIS do site
//   (dropdown da própria Categoria/Subcategoria) antes de lançar — nunca
//   assumidas a partir do que a IA extraiu do texto.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config()

const fs = require('fs')
const path = require('path')
const Groq = require('groq-sdk')
const Anthropic = require('@anthropic-ai/sdk')
const rawPuppeteer = require('puppeteer')
const { resolverChrome } = require('./shopee-agent')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
const anthropic = new Anthropic({ timeout: 30000 })
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'

const FINANCEIRO_URL = 'https://grupoz.base44.app/financeiro'

// Perfil próprio, nunca o mesmo de planner_profile/shopee_profile/finn_profile
const PROFILE_DIR = process.env.EMPRESA_PROFILE_DIR || path.join(__dirname, 'empresa_profile')
const DEBUG_DIR = path.join(__dirname, 'debug_financeiro')
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR)

const TIMEOUT_LOGIN_MS = 5 * 60 * 1000 // 5 min aguardando login manual

const EMPRESAS = ['Ziont', 'Zark']

function esperar(ms) { return new Promise(r => setTimeout(r, ms)) }

function hojeBR() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}

function formatarBR(n) {
    return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Resolve o nome canônico contra uma lista de opções reais, ignorando caixa
function casarNome(entrada, opcoes) {
    if (!entrada) return null
    const norm = s => s.toString().trim().toLowerCase()
    const alvo = norm(entrada)
    return opcoes.find(o => norm(o) === alvo) || null
}

// ───────────────────────── Cache local de categorias/subcategorias reais ─────────────────────────
// Persistido em empresa_varredura.json (mesmo arquivo do flag de varredura, chave própria)
// pra nunca precisar reabrir o site só pra confirmar uma categoria/subcategoria já conhecida
// — só consulta o site de verdade quando o nome não bate com nada salvo localmente.
const CACHE_ARQUIVO_FILE = path.join(__dirname, 'empresa_varredura.json')

function carregarArquivoEstado() {
    try { if (fs.existsSync(CACHE_ARQUIVO_FILE)) return JSON.parse(fs.readFileSync(CACHE_ARQUIVO_FILE, 'utf8')) } catch {}
    return {}
}
function salvarCategoriasConhecidasArquivo(categorias) {
    const estado = carregarArquivoEstado()
    estado.categoriasConhecidas = categorias
    estado.categoriasAtualizadasEm = new Date().toISOString()
    fs.writeFileSync(CACHE_ARQUIVO_FILE, JSON.stringify(estado, null, 2))
}

// { [categoriaReal]: { subs: [nomesReais...] } } — carregado 1x no início do processo
let categoriasReaisCache = carregarArquivoEstado().categoriasConhecidas || {}

function categoriaConhecidaLocal(nome) {
    return casarNome(nome, Object.keys(categoriasReaisCache))
}
function subcategoriaConhecidaLocal(categoriaReal, nome) {
    const subs = categoriasReaisCache[categoriaReal]?.subs || []
    return casarNome(nome, subs)
}
// Registra (ou atualiza) uma categoria real conhecida — subs, se informado, SUBSTITUI a
// lista (usado após ler o dropdown de verdade, que é sempre a fonte completa e atual).
function registrarCategoriaReal(categoriaReal, subs) {
    if (!categoriasReaisCache[categoriaReal]) categoriasReaisCache[categoriaReal] = { subs: [] }
    if (Array.isArray(subs)) categoriasReaisCache[categoriaReal].subs = subs
    salvarCategoriasConhecidasArquivo(categoriasReaisCache)
}
// Adiciona uma subcategoria conhecida sem descartar as demais já salvas (usado quando só
// confirmamos UMA subcategoria específica, não a lista inteira)
function registrarSubcategoriaReal(categoriaReal, subcategoriaReal) {
    if (!categoriasReaisCache[categoriaReal]) categoriasReaisCache[categoriaReal] = { subs: [] }
    const subs = categoriasReaisCache[categoriaReal].subs
    if (!subs.some(s => s.toLowerCase() === subcategoriaReal.toLowerCase())) subs.push(subcategoriaReal)
    salvarCategoriasConhecidasArquivo(categoriasReaisCache)
}

// Extrai o primeiro objeto JSON de um texto (a IA às vezes escreve algo antes/depois)
function extrairJSON(texto) {
    const m = texto.match(/\{[\s\S]*\}/)
    if (!m) throw new Error('Nenhum JSON encontrado na resposta')
    return JSON.parse(m[0])
}

// Emoji por categoria/subcategoria conhecida — fallback genérico pras novas
const EMOJIS = {
    'Transporte': '🚗', 'Publicidade': '📢', 'Pró-labore': '💼', 'Outros': '📦',
    'Empréstimo': '🏦', 'Plataformas': '🛒',
}
function emojiPara(categoria, subcategoria) {
    return EMOJIS[subcategoria] || EMOJIS[categoria] || '💰'
}

// Pré-filtro leve — o grupo é 100% dedicado a financeiro, então basta ter um número na
// mensagem (diferente do pré-filtro do planner pessoal, que precisa de palavras-chave
// porque convive com conversa comum). Falsos positivos aqui só custam uma chamada Groq
// a mais — normalizarDadosBrutos descarta silenciosamente o que não for uma despesa real.
function pareceDespesaFinanceiro(texto) {
    return !!texto && /\d/.test(texto)
}

// ───────────────────────── Interpretação via IA ─────────────────────────

function montarPromptDespesa(categoriasConhecidasTexto) {
    return `Você interpreta mensagens do grupo de WhatsApp financeiro de uma empresa (Zark e Ziont), onde
qualquer membro do grupo pode lançar uma despesa em texto livre, foto de nota fiscal ou boleto em PDF.
Extraia os dados da despesa mencionada.

EMPRESAS VÁLIDAS: Ziont, Zark. Preencha "empresa" SOMENTE se a mensagem citar claramente uma delas
(nome exato ou variação óbvia); caso contrário deixe "".

CATEGORIAS JÁ CADASTRADAS NO SISTEMA (reaproveite uma destas se o gasto se encaixar; se nenhuma fizer
sentido, sugira um nome de categoria novo, curto e claro, em vez de forçar uma categoria errada):
${categoriasConhecidasTexto}

REGRAS:
- valor: número decimal com ponto (ex: 12.82). Aceite vírgula, ponto, "R$", "$" ou "reais" na entrada.
- categoria: nome da categoria (reaproveitando uma cadastrada quando fizer sentido, ou sugerindo uma nova).
- subcategoria: preencha SOMENTE se identificar uma subcategoria clara; senão "".
- descricao: breve (poucas palavras) — nome do fornecedor/serviço/item.
- data: AAAA-MM-DD. Use a data de hoje informada se não houver outra data clara na mensagem.
- status: "Pendente" se a conta AINDA NÃO foi paga (ex: "boleto", "a pagar", "vence", "venceu"); "Concluído"
  se já foi paga ou não houver indicação — "Concluído" é o padrão.
- conta: nome do banco/forma de pagamento (ex: "Mercado Pago", "Nubank"), SOMENTE se mencionado
  explicitamente. Senão "".
- cartao: nome/identificação do cartão de crédito, SOMENTE se mencionado explicitamente. Senão "".
- confianca: número de 0 a 1 indicando o quão seguro você está da categoria escolhida.

Responda EXCLUSIVAMENTE em JSON, sem texto fora do JSON:
{"valor": 0.00, "empresa": "", "categoria": "...", "subcategoria": "", "descricao": "...", "data": "AAAA-MM-DD", "status": "Concluído", "conta": "", "cartao": "", "confianca": 0.0}`
}

function descreverCategoriasConhecidas(lista) {
    if (!lista || !lista.length) return '(nenhuma categoria cadastrada ainda — sugira uma)'
    return lista.map(c => (c.subs && c.subs.length) ? `${c.nome} (${c.subs.join(', ')})` : c.nome).join(' | ')
}

// Retorna { ok, dados?, motivo? }. dados = { valor, empresa, categoria, subcategoria, descricao, data, status, conta, cartao, confianca }
async function interpretarDespesaTexto(texto, categoriasConhecidas = []) {
    const hoje = hojeBR()
    let bruto
    try {
        const resp = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            max_tokens: 400,
            temperature: 0.1,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: `${montarPromptDespesa(descreverCategoriasConhecidas(categoriasConhecidas))}\n\nData de hoje: ${hoje}` },
                { role: 'user', content: texto },
            ],
        })
        bruto = extrairJSON(resp.choices[0].message.content)
    } catch (err) {
        return { ok: false, motivo: `Não consegui interpretar a mensagem (${err.message}).` }
    }
    return normalizarDadosBrutos(bruto, hoje)
}

// Nota fiscal / comprovante (imagem) via Claude Vision — extrai só valor/descrição/data,
// como pedido: uma foto de nota não costuma revelar empresa/categoria certas.
async function interpretarNotaFiscalImagem(imagemBase64, mimeType = 'image/jpeg') {
    const hoje = hojeBR()
    let resp
    try {
        resp = await anthropic.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: 400,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: mimeType, data: imagemBase64 } },
                    {
                        type: 'text',
                        text: `Esta é uma foto de nota fiscal ou comprovante de pagamento. Extraia APENAS o valor `
                            + `total, uma descrição breve (nome do estabelecimento/serviço) e a data (AAAA-MM-DD, `
                            + `use ${hoje} se não estiver legível). Responda EXCLUSIVAMENTE em JSON, sem texto fora `
                            + `do JSON: {"valor": 0.00, "descricao": "...", "data": "AAAA-MM-DD"}`,
                    },
                ],
            }],
        })
    } catch (err) {
        return { ok: false, motivo: `Não consegui ler a nota fiscal (${err.message}).` }
    }

    let bruto
    try {
        const textBlock = resp.content.find(b => b.type === 'text')
        bruto = extrairJSON(textBlock.text)
    } catch (err) {
        return { ok: false, motivo: 'Não consegui interpretar os dados extraídos da nota fiscal.' }
    }

    const valor = Number(String(bruto.valor).replace(',', '.'))
    if (!Number.isFinite(valor) || valor <= 0) {
        return { ok: false, motivo: 'Não identifiquei um valor válido na nota fiscal.' }
    }
    const data = /^\d{4}-\d{2}-\d{2}$/.test(bruto.data || '') ? bruto.data : hoje
    const descricao = (bruto.descricao || '').toString().trim() || 'Nota fiscal'

    return {
        ok: true,
        dados: { valor, empresa: '', categoria: '', subcategoria: '', descricao, data, status: 'Concluído', conta: '', cartao: '', confianca: 0 },
    }
}

function normalizarDadosBrutos(bruto, hoje) {
    const valor = Number(String(bruto.valor).replace(',', '.'))
    if (!Number.isFinite(valor) || valor <= 0) {
        return { ok: false, motivo: 'Não identifiquei um valor válido na mensagem.' }
    }

    const empresa = casarNome(bruto.empresa, EMPRESAS) || ''
    const data = /^\d{4}-\d{2}-\d{2}$/.test(bruto.data || '') ? bruto.data : hoje
    const status = bruto.status === 'Pendente' ? 'Pendente' : 'Concluído'
    const categoria = (bruto.categoria || '').toString().trim()
    const subcategoria = (bruto.subcategoria || '').toString().trim()
    const descricao = (bruto.descricao || '').toString().trim() || subcategoria || categoria || 'Despesa'
    const conta = (bruto.conta || '').toString().trim()
    const cartao = (bruto.cartao || '').toString().trim()
    const confianca = Number(bruto.confianca)

    if (!categoria) {
        return { ok: false, motivo: 'Não identifiquei a categoria dessa despesa.' }
    }

    return {
        ok: true,
        dados: { valor, empresa, categoria, subcategoria, descricao, data, status, conta, cartao, confianca: Number.isFinite(confianca) ? confianca : 0.5 },
    }
}

// ───────────────────────── Browser persistente ─────────────────────────

let financeiroBrowser = null
let financeiroPage = null
let ocupado = false // mutex: um lançamento por vez sobre a página compartilhada

async function abrirFinanceiroBrowser() {
    if (financeiroBrowser && financeiroBrowser.isConnected() && financeiroPage && !financeiroPage.isClosed()) {
        return { browser: financeiroBrowser, page: financeiroPage }
    }
    if (financeiroBrowser) { try { await financeiroBrowser.close() } catch {} }
    financeiroBrowser = null
    financeiroPage = null

    const chromePath = resolverChrome()
    console.log(`🌐 [Financeiro] Abrindo navegador — path: ${chromePath}`)
    financeiroBrowser = await rawPuppeteer.launch({
        headless: false,
        executablePath: chromePath,
        userDataDir: PROFILE_DIR,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,900', '--lang=pt-BR'],
    })
    financeiroBrowser.on('disconnected', () => {
        console.log('⚠️  [Financeiro] Navegador fechou — será reaberto no próximo lançamento.')
        financeiroBrowser = null
        financeiroPage = null
    })

    const paginas = await financeiroBrowser.pages()
    financeiroPage = paginas[0] || await financeiroBrowser.newPage()
    await financeiroPage.setViewport({ width: 1440, height: 900 })
    await financeiroPage.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' })

    return { browser: financeiroBrowser, page: financeiroPage }
}

// Detecta se a página está pedindo login (campo de senha/email visível) vs já logada
// (menu lateral do app visível). Timeout curto com fallback pela URL.
async function precisaLogin(page) {
    try {
        const SEL_LOGIN = 'input[type="password"], input[type="email"]'
        const SEL_APP = 'nav, [class*="sidebar" i]'
        const resultado = await Promise.race([
            page.waitForSelector(SEL_LOGIN, { visible: true, timeout: 8000 }).then(() => true),
            page.waitForSelector(SEL_APP, { visible: true, timeout: 8000 }).then(() => false),
        ]).catch(() => !/\/financeiro/i.test(page.url()))
        return resultado
    } catch { return true }
}

// Login SEMPRE manual (sem credenciais no .env) — só espera o dono/membro logar na
// janela visível. A sessão persiste no profile entre reinícios (cookie de longa duração
// do base44), então isso só deve acontecer de verdade na primeira execução.
async function garantirLogado(page, onStatus) {
    if (!page.url().includes('/financeiro')) {
        await page.goto(FINANCEIRO_URL, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {})
    }
    if (!(await precisaLogin(page))) return

    if (onStatus) onStatus('🔐 Preciso que alguém faça login manualmente na janela do navegador que abri (primeira vez). Você tem 5 minutos.')
    console.log('🔐 [Financeiro] Aguardando login manual (até 5 min)...')

    const inicio = Date.now()
    while (Date.now() - inicio < TIMEOUT_LOGIN_MS) {
        await esperar(3000)
        if (!(await precisaLogin(page))) {
            console.log('✅ [Financeiro] Login detectado.')
            return
        }
    }
    throw new Error('LOGIN_TIMEOUT')
}

async function fecharModal(page) {
    await page.keyboard.press('Escape').catch(() => {})
    await esperar(300)
}

async function clicarAba(page, textoAba) {
    const clicado = await page.evaluate((texto) => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === texto)
        if (!btn) return false
        btn.click()
        return true
    }, textoAba)
    if (!clicado) throw new Error(`Aba "${textoAba}" não encontrada`)
    await esperar(600)
}

async function abrirModalSaida(page) {
    if (!page.url().includes('/financeiro')) {
        await page.goto(FINANCEIRO_URL, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {})
    }
    await clicarAba(page, 'Lançamentos')
    const clicado = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Saída')
        if (!btn) return false
        btn.click()
        return true
    })
    if (!clicado) throw new Error('Botão "Saída" não encontrado')
    await esperar(600)
}

// Localiza o controle (button/input/textarea) associado a um <label> pelo texto exato
async function elementoPorLabel(page, labelTexto) {
    const handle = await page.evaluateHandle((texto) => {
        const label = [...document.querySelectorAll('label')].find(l => l.textContent.trim() === texto)
        if (!label) return null
        return label.parentElement ? label.parentElement.querySelector('button, input, textarea') : null
    }, labelTexto)
    return handle && handle.asElement ? handle.asElement() : null
}

async function setarInputPorLabel(page, labelTexto, valor) {
    const el = await elementoPorLabel(page, labelTexto)
    if (!el) throw new Error(`Campo "${labelTexto}" não encontrado`)
    await page.evaluate((el, val) => {
        const isTextArea = el.tagName === 'TEXTAREA'
        const proto = isTextArea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(el, val); else el.value = val
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
    }, el, String(valor))
}

async function abrirComboBox(page, labelTexto) {
    const el = await elementoPorLabel(page, labelTexto)
    if (!el) throw new Error(`Campo "${labelTexto}" não encontrado`)
    await el.click()
    await esperar(350)
}

// Lê as opções do dropdown recém-aberto. As opções da grupoz.base44.app são divs/li
// sem role="option" formal — filtra por elemento-folha visível dentro de um listbox,
// com fallback genérico caso a estrutura não use role="listbox".
async function lerOpcoesComboBoxAberto(page) {
    return page.evaluate(() => {
        let els = []
        const listbox = document.querySelector('[role="listbox"]')
        if (listbox) {
            els = [...listbox.querySelectorAll('[role="option"], li, div')].filter(el => el.offsetParent !== null)
        }
        if (!els.length) {
            els = [...document.querySelectorAll('[role="option"]')].filter(el => el.offsetParent !== null)
        }
        const textos = els
            .filter(el => el.children.length === 0)
            .map(el => el.textContent.trim())
            .filter(t => t && t.length < 60)
        return [...new Set(textos)]
    })
}

async function clicarOpcao(page, texto) {
    const handle = await page.evaluateHandle((texto) => {
        const els = [...document.querySelectorAll('[role="option"], li, div')]
        return els.find(el => el.children.length === 0 && el.textContent.trim() === texto && el.offsetParent !== null) || null
    }, texto)
    const el = handle && handle.asElement ? handle.asElement() : null
    if (!el) return false
    await el.click()
    await esperar(300)
    return true
}

async function selecionarComboBoxPorLabel(page, labelTexto, textoOpcao) {
    await abrirComboBox(page, labelTexto)
    const ok = await clicarOpcao(page, textoOpcao)
    if (!ok) {
        await page.screenshot({ path: path.join(DEBUG_DIR, `combobox_${labelTexto.replace(/\s+/g, '_')}_opcao_nao_encontrada.png`) }).catch(() => {})
        throw new Error(`Opção "${textoOpcao}" não encontrada em "${labelTexto}"`)
    }
}

// Valida categoria/subcategoria contra as opções REAIS do <select> do site (modal já
// aberto) — nunca confia cegamente no nome que a IA extraiu do texto. Lança erro com
// `.code` CATEGORIA_NAO_ENCONTRADA / SUBCATEGORIA_NAO_ENCONTRADA + as opções reais,
// pro chamador decidir se pergunta ou oferece criar uma nova.
async function validarESelecionarCategoria(page, categoria, subcategoria) {
    await abrirComboBox(page, 'Categoria')
    const categoriasReais = await lerOpcoesComboBoxAberto(page)
    const categoriaReal = casarNome(categoria, categoriasReais)
    if (!categoriaReal) {
        await page.keyboard.press('Escape').catch(() => {})
        const err = new Error(`Categoria "${categoria}" não existe no site.`)
        err.code = 'CATEGORIA_NAO_ENCONTRADA'
        err.categoriasDisponiveis = categoriasReais
        throw err
    }
    await clicarOpcao(page, categoriaReal)
    await esperar(800) // React carrega as subcategorias dependentes

    let subcategoriaReal = ''
    if (subcategoria) {
        await abrirComboBox(page, 'Subcategoria')
        const subsReais = await lerOpcoesComboBoxAberto(page)
        subcategoriaReal = casarNome(subcategoria, subsReais)
        if (!subcategoriaReal) {
            await page.keyboard.press('Escape').catch(() => {})
            const err = new Error(`Subcategoria "${subcategoria}" não existe em "${categoriaReal}".`)
            err.code = 'SUBCATEGORIA_NAO_ENCONTRADA'
            err.categoria = categoriaReal
            err.subcategoriasDisponiveis = subsReais
            throw err
        }
        await clicarOpcao(page, subcategoriaReal)
        await esperar(300)
    }
    return { categoriaReal, subcategoriaReal }
}

// Lista as categorias de despesa REAIS (abre o modal Saída, lê o dropdown Categoria e
// fecha sem salvar) — usado pra reconhecer categoria já cadastrada ANTES de perguntar
// se deve criar uma nova (evita pedir confirmação de criação de algo que já existe).
async function listarCategoriasDespesaReais({ onStatus } = {}) {
    if (ocupado) throw new Error('Já estou ocupado com outro lançamento — tente de novo em instantes.')
    ocupado = true
    let page
    try {
        ;({ page } = await abrirFinanceiroBrowser())
        await garantirLogado(page, onStatus)
        await abrirModalSaida(page)
        await abrirComboBox(page, 'Categoria')
        const categorias = await lerOpcoesComboBoxAberto(page)
        await fecharModal(page)
        for (const c of categorias) registrarCategoriaReal(c) // atualiza o cache local (preserva subs já conhecidas)
        return categorias
    } finally {
        ocupado = false
    }
}

// Lista as subcategorias REAIS de uma categoria já existente
async function listarSubcategoriasReais(categoria, { onStatus } = {}) {
    if (ocupado) throw new Error('Já estou ocupado com outro lançamento — tente de novo em instantes.')
    ocupado = true
    let page
    try {
        ;({ page } = await abrirFinanceiroBrowser())
        await garantirLogado(page, onStatus)
        await abrirModalSaida(page)
        await abrirComboBox(page, 'Categoria')
        const categorias = await lerOpcoesComboBoxAberto(page)
        const categoriaReal = casarNome(categoria, categorias)
        if (!categoriaReal) { await fecharModal(page); return [] }
        await clicarOpcao(page, categoriaReal)
        await esperar(800)
        await abrirComboBox(page, 'Subcategoria')
        const subs = await lerOpcoesComboBoxAberto(page)
        await fecharModal(page)
        registrarCategoriaReal(categoriaReal, subs) // fonte completa e atual — substitui a lista de subs em cache
        return subs
    } finally {
        ocupado = false
    }
}

// Verifica se uma categoria já é conhecida — cache local PRIMEIRO, só acessa o site se
// não achar nada salvo (requisito: "só atualizar do site se a categoria não estiver na
// lista local"). Retorna o nome REAL exato (case do site), ou null se não existir.
async function verificarCategoriaExistente(nomeCategoria, { onStatus } = {}) {
    const doCache = categoriaConhecidaLocal(nomeCategoria)
    if (doCache) return doCache
    const categoriasReais = await listarCategoriasDespesaReais({ onStatus })
    return casarNome(nomeCategoria, categoriasReais)
}

// Mesma lógica para subcategoria, dado o nome REAL da categoria já resolvido
async function verificarSubcategoriaExistente(categoriaReal, nomeSubcategoria, { onStatus } = {}) {
    const doCache = subcategoriaConhecidaLocal(categoriaReal, nomeSubcategoria)
    if (doCache) return doCache
    const subsReais = await listarSubcategoriasReais(categoriaReal, { onStatus })
    return casarNome(nomeSubcategoria, subsReais)
}

async function preencherRestanteESalvar(page, dados) {
    const dataEl = await elementoPorLabel(page, 'Data')
    if (dataEl) {
        await page.evaluate((el, val) => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
            if (setter) setter.call(el, val); else el.value = val
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
        }, dataEl, dados.data)
        await esperar(200)
    }

    await selecionarComboBoxPorLabel(page, 'Empresa', dados.empresa)
    await esperar(300)

    if (dados.conta) { await setarInputPorLabel(page, 'Conta', dados.conta); await esperar(200) }
    if (dados.cartao) { await setarInputPorLabel(page, 'Cartão de crédito', dados.cartao); await esperar(200) }

    await setarInputPorLabel(page, 'Valor (R$)', dados.valor.toFixed(2))
    await esperar(200)

    await selecionarComboBoxPorLabel(page, 'Status', dados.status || 'Concluído')
    await esperar(200)

    await setarInputPorLabel(page, 'Descrição', dados.descricao)
    await esperar(200)

    await page.screenshot({ path: path.join(DEBUG_DIR, 'antes_salvar.png') }).catch(() => {})

    const clicouSalvar = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button[type="submit"]')].find(b => b.offsetParent !== null)
            || [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Salvar')
        if (!btn) return false
        btn.click()
        return true
    })
    if (!clicouSalvar) throw new Error('Botão "Salvar" não encontrado')

    await esperar(2000)
    await page.screenshot({ path: path.join(DEBUG_DIR, 'apos_salvar.png') }).catch(() => {})

    const modalAindaAberto = await page.evaluate(() =>
        !![...document.querySelectorAll('h2, h3')].find(el => el.textContent.trim().startsWith('Novo Lançamento'))
    )
    if (modalAindaAberto) {
        throw new Error('O formulário não fechou após salvar — algum campo obrigatório pode não ter sido preenchido corretamente. Veja debug_financeiro/apos_salvar.png')
    }
}

// Lê o card "LIMITE DE GASTO POR CATEGORIA · MÊS ATUAL" na aba Resumo
async function lerLimiteCategoria(page, nomeItem) {
    if (!page.url().includes('/financeiro')) {
        await page.goto(FINANCEIRO_URL, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {})
    }
    await clicarAba(page, 'Resumo')
    await esperar(500)
    const texto = await page.evaluate(() => document.querySelector('main')?.innerText || document.body.innerText)
    const idx = texto.toUpperCase().indexOf('LIMITE DE GASTO POR CATEGORIA')
    if (idx === -1) return null
    const linhas = texto.slice(idx, idx + 1000).split('\n').map(l => l.trim()).filter(Boolean)
    for (let i = 0; i < linhas.length; i++) {
        if (linhas[i].toLowerCase() === nomeItem.toLowerCase() && linhas[i + 1]) {
            const m = linhas[i + 1].match(/R\$\s*([\d.,]+)\s*\/\s*R\$\s*([\d.,]+)/)
            if (m) {
                const realizado = Number(m[1].replace(/\./g, '').replace(',', '.'))
                const limite = Number(m[2].replace(/\./g, '').replace(',', '.'))
                return { realizado, limite, percentual: limite > 0 ? (realizado / limite) * 100 : null }
            }
        }
    }
    return null
}

async function cadastrarDespesaEmpresa(dados, { onStatus } = {}) {
    if (ocupado) throw new Error('Já estou cadastrando outro lançamento — tente de novo em instantes.')
    ocupado = true
    let page
    try {
        ;({ page } = await abrirFinanceiroBrowser())
        await garantirLogado(page, onStatus)
        await abrirModalSaida(page)

        const { categoriaReal, subcategoriaReal } = await validarESelecionarCategoria(page, dados.categoria, dados.subcategoria)
        await preencherRestanteESalvar(page, { ...dados, categoria: categoriaReal, subcategoria: subcategoriaReal })

        console.log(`✅ [Financeiro] Lançado: ${dados.descricao} — R$ ${dados.valor.toFixed(2)} (${categoriaReal}${subcategoriaReal ? '/' + subcategoriaReal : ''}) — ${dados.empresa}`)

        let limiteInfo = null
        try {
            limiteInfo = await lerLimiteCategoria(page, subcategoriaReal || categoriaReal)
        } catch (e) {
            console.log(`⚠️  [Financeiro] Não consegui ler o limite: ${e.message}`)
        }

        return {
            valorLancado: dados.valor,
            empresa: dados.empresa,
            categoria: categoriaReal,
            subcategoria: subcategoriaReal || null,
            descricao: dados.descricao,
            status: dados.status || 'Concluído',
            limiteInfo,
        }
    } catch (err) {
        if (page) await fecharModal(page).catch(() => {})
        throw err
    } finally {
        ocupado = false
    }
}

// Cria categoria nova (Tipo = Despesa, padrão do formulário) com subcategoria opcional
async function preencherFormularioNovaCategoria(page, nomeCategoria, nomeSubcategoria) {
    const clicouNova = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim().includes('Nova Categoria'))
        if (!btn) return false
        btn.click()
        return true
    })
    if (!clicouNova) throw new Error('Botão "Nova Categoria" não encontrado')
    await esperar(500)

    await setarInputPorLabel(page, 'Nome', nomeCategoria)
    await esperar(200)
    // Tipo já vem "Despesa" por padrão no formulário — não precisa mexer

    if (nomeSubcategoria) {
        await adicionarLinhaSubcategoria(page, nomeSubcategoria)
    }

    await page.screenshot({ path: path.join(DEBUG_DIR, 'categoria_antes_salvar.png') }).catch(() => {})
    await clicarSalvarCategoria(page)
}

const MAX_TENTATIVAS_CRIACAO = 2

// Cria a categoria (+ subcategoria opcional) e SÓ retorna sucesso depois de reabrir o
// dropdown real de Categoria/Subcategoria e confirmar que ela aparece de verdade —
// nunca assume que "clicou Salvar" == "foi criada". Tenta até MAX_TENTATIVAS_CRIACAO
// vezes antes de desistir. Retorna { categoria, subcategoria } com os nomes EXATOS
// confirmados no site (pra usar direto no lançamento, sem perguntar de novo ao usuário).
async function criarCategoriaComSubcategoria(nomeCategoria, nomeSubcategoria, { onStatus } = {}) {
    if (ocupado) throw new Error('Já estou ocupado com outro lançamento — tente de novo em instantes.')
    ocupado = true
    let page
    try {
        ;({ page } = await abrirFinanceiroBrowser())
        await garantirLogado(page, onStatus)

        for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_CRIACAO; tentativa++) {
            await clicarAba(page, 'Planejamento e Controle')
            await esperar(500)
            await preencherFormularioNovaCategoria(page, nomeCategoria, nomeSubcategoria)

            // Verificação de verdade: reabre o modal de Saída e confere no dropdown real
            await abrirModalSaida(page)
            await abrirComboBox(page, 'Categoria')
            const categoriasReais = await lerOpcoesComboBoxAberto(page)
            const categoriaConfirmada = casarNome(nomeCategoria, categoriasReais)

            let subConfirmada = null
            if (categoriaConfirmada && nomeSubcategoria) {
                await clicarOpcao(page, categoriaConfirmada)
                await esperar(800)
                await abrirComboBox(page, 'Subcategoria')
                const subsReais = await lerOpcoesComboBoxAberto(page)
                subConfirmada = casarNome(nomeSubcategoria, subsReais)
                if (subConfirmada) registrarCategoriaReal(categoriaConfirmada, subsReais)
            } else if (categoriaConfirmada) {
                registrarCategoriaReal(categoriaConfirmada)
            }
            await fecharModal(page)

            const precisaSub = !!nomeSubcategoria
            if (categoriaConfirmada && (!precisaSub || subConfirmada)) {
                console.log(`✅ [Financeiro] Categoria confirmada no site: ${categoriaConfirmada}${subConfirmada ? ' / ' + subConfirmada : ''} (tentativa ${tentativa}/${MAX_TENTATIVAS_CRIACAO})`)
                return { categoria: categoriaConfirmada, subcategoria: subConfirmada || null }
            }
            console.log(`⚠️  [Financeiro] Categoria/subcategoria não apareceu no site após criar (tentativa ${tentativa}/${MAX_TENTATIVAS_CRIACAO}) — tentando de novo...`)
        }

        throw new Error(`Não consegui confirmar a categoria "${nomeCategoria}"${nomeSubcategoria ? ` / subcategoria "${nomeSubcategoria}"` : ''} no site após ${MAX_TENTATIVAS_CRIACAO} tentativas`)
    } finally {
        ocupado = false
    }
}

async function clicarEditarCategoria(page, nomeCategoria) {
    // Risco não verificado: acha o card da categoria pelo nome exato e sobe até achar
    // um contêiner com 2+ botões visíveis (lápis + lixeira), clicando o primeiro
    // (lápis, assumido como o botão de editar por ordem visual observada ao vivo).
    const clicouEditar = await page.evaluate((nome) => {
        const nomeEl = [...document.querySelectorAll('*')].find(el =>
            el.children.length === 0 && el.textContent.trim() === nome)
        if (!nomeEl) return false
        let container = nomeEl.parentElement
        for (let i = 0; i < 6 && container; i++) {
            const botoes = [...container.querySelectorAll('button')].filter(b => b.offsetParent !== null)
            if (botoes.length >= 2) { botoes[0].click(); return true }
            container = container.parentElement
        }
        return false
    }, nomeCategoria)
    if (!clicouEditar) {
        await page.screenshot({ path: path.join(DEBUG_DIR, 'categoria_editar_nao_encontrada.png') }).catch(() => {})
        throw new Error(`Categoria "${nomeCategoria}" não encontrada para edição (veja debug_financeiro/categoria_editar_nao_encontrada.png)`)
    }
    await esperar(500)
}

// Adiciona uma subcategoria nova a uma categoria JÁ EXISTENTE (abre via lápis de edição),
// verifica de verdade no dropdown real antes de dar como concluído (mesma lógica de
// retry/verificação de criarCategoriaComSubcategoria). Retorna o nome EXATO confirmado.
async function adicionarSubcategoriaEmCategoriaExistente(nomeCategoria, nomeSubcategoria, { onStatus } = {}) {
    if (ocupado) throw new Error('Já estou ocupado com outro lançamento — tente de novo em instantes.')
    ocupado = true
    let page
    try {
        ;({ page } = await abrirFinanceiroBrowser())
        await garantirLogado(page, onStatus)

        for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_CRIACAO; tentativa++) {
            await clicarAba(page, 'Planejamento e Controle')
            await esperar(500)
            await clicarEditarCategoria(page, nomeCategoria)
            await adicionarLinhaSubcategoria(page, nomeSubcategoria)
            await page.screenshot({ path: path.join(DEBUG_DIR, 'subcategoria_antes_salvar.png') }).catch(() => {})
            await clicarSalvarCategoria(page)

            // Verificação de verdade contra o dropdown real
            await abrirModalSaida(page)
            await abrirComboBox(page, 'Categoria')
            const categoriasReais = await lerOpcoesComboBoxAberto(page)
            const categoriaReal = casarNome(nomeCategoria, categoriasReais)
            let subConfirmada = null
            if (categoriaReal) {
                await clicarOpcao(page, categoriaReal)
                await esperar(800)
                await abrirComboBox(page, 'Subcategoria')
                const subsReais = await lerOpcoesComboBoxAberto(page)
                subConfirmada = casarNome(nomeSubcategoria, subsReais)
                if (subConfirmada) registrarCategoriaReal(categoriaReal, subsReais)
            }
            await fecharModal(page)

            if (categoriaReal && subConfirmada) {
                console.log(`✅ [Financeiro] Subcategoria confirmada no site: ${categoriaReal} / ${subConfirmada} (tentativa ${tentativa}/${MAX_TENTATIVAS_CRIACAO})`)
                return { categoria: categoriaReal, subcategoria: subConfirmada }
            }
            console.log(`⚠️  [Financeiro] Subcategoria não apareceu no site após criar (tentativa ${tentativa}/${MAX_TENTATIVAS_CRIACAO}) — tentando de novo...`)
        }

        throw new Error(`Não consegui confirmar a subcategoria "${nomeSubcategoria}" em "${nomeCategoria}" no site após ${MAX_TENTATIVAS_CRIACAO} tentativas`)
    } finally {
        ocupado = false
    }
}

async function adicionarLinhaSubcategoria(page, nomeSubcategoria) {
    const clicouAdicionar = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim().includes('Adicionar'))
        if (!btn) return false
        btn.click()
        return true
    })
    if (!clicouAdicionar) throw new Error('Botão "Adicionar" (subcategoria) não encontrado')
    await esperar(300)

    const okSub = await page.evaluate((nome) => {
        const input = [...document.querySelectorAll('input[placeholder="Nome"]')].find(el => el.offsetParent !== null)
        if (!input) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        setter.call(input, nome)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
        return true
    }, nomeSubcategoria)
    if (!okSub) throw new Error('Campo de nome da subcategoria não encontrado')
    await esperar(200)
}

async function clicarSalvarCategoria(page) {
    const salvou = await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Salvar')
        if (!btn) return false
        btn.click()
        return true
    })
    if (!salvou) throw new Error('Botão "Salvar" não encontrado')
    await esperar(1500)
}

// Lê a aba "Planejamento e Controle" pra dar contexto de categorias já cadastradas ao
// prompt do Groq. Tolerante a erro de parsing — usado só como dica, não como validação
// (a validação de verdade é feita contra o <select> real no momento do lançamento).
async function listarPlanejamento(page) {
    try {
        if (!page.url().includes('/financeiro')) {
            await page.goto(FINANCEIRO_URL, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {})
        }
        await clicarAba(page, 'Planejamento e Controle')
        await esperar(500)
        const texto = await page.evaluate(() => document.querySelector('main')?.innerText || document.body.innerText)
        const linhas = texto.split('\n').map(l => l.trim()).filter(Boolean)
        const categorias = []
        let atual = null
        for (let i = 0; i < linhas.length; i++) {
            const linha = linhas[i]
            if (/^Limite: R\$/.test(linha)) continue
            if (linhas[i + 1] && /^Limite: R\$/.test(linhas[i + 1])) {
                atual = { nome: linha, subs: [] }
                categorias.push(atual)
                i++
                continue
            }
            if (atual && linhas[i + 1] && /^R\$\s?[\d.,]+\/mês$/.test(linhas[i + 1])) {
                atual.subs.push(linha)
                i++
            }
        }
        return categorias
    } catch {
        return []
    }
}

let categoriasCache = null // { timestamp, lista }
const CATEGORIAS_CACHE_TTL = 10 * 60 * 1000

// Lista de categorias conhecidas (cache de 10 min) — usada só como contexto pro prompt
// do Groq, nunca pra validação real (essa é sempre contra o site no momento do lançamento).
async function obterCategoriasConhecidas({ onStatus } = {}) {
    if (categoriasCache && Date.now() - categoriasCache.timestamp < CATEGORIAS_CACHE_TTL) {
        return categoriasCache.lista
    }
    try {
        const { page } = await abrirFinanceiroBrowser()
        await garantirLogado(page, onStatus)
        const lista = await listarPlanejamento(page)
        categoriasCache = { timestamp: Date.now(), lista }
        return lista
    } catch (e) {
        console.log(`⚠️  [Financeiro] Não consegui listar categorias conhecidas: ${e.message}`)
        return categoriasCache ? categoriasCache.lista : []
    }
}

function invalidarCacheCategorias() {
    categoriasCache = null
}

function formatarConfirmacao(r) {
    const emoji = emojiPara(r.categoria, r.subcategoria)
    const item = r.subcategoria || r.categoria
    let linhaLimite = ''
    if (r.limiteInfo && r.limiteInfo.limite > 0 && r.limiteInfo.percentual != null) {
        const pct = r.limiteInfo.percentual
        const iconePct = pct >= 100 ? '🔴' : pct >= 90 ? '🟠' : pct >= 50 ? '🟡' : '🟢'
        linhaLimite = `\n\n${iconePct} R$ ${formatarBR(r.limiteInfo.realizado)} / R$ ${formatarBR(r.limiteInfo.limite)} (${pct.toFixed(0)}%) em ${item} este mês`
    }
    const statusTxt = r.status === 'Pendente' ? '\n⚠️ Status: Pendente' : ''
    return `✅ Despesa registrada!\n\n${emoji} R$ ${formatarBR(r.valorLancado)} em ${item}\n🏢 Empresa: ${r.empresa}${statusTxt}${linhaLimite}`
}

module.exports = {
    EMPRESAS,
    emojiPara,
    casarNome,
    pareceDespesaFinanceiro,
    interpretarDespesaTexto,
    interpretarNotaFiscalImagem,
    obterCategoriasConhecidas,
    invalidarCacheCategorias,
    listarCategoriasDespesaReais,
    listarSubcategoriasReais,
    verificarCategoriaExistente,
    verificarSubcategoriaExistente,
    cadastrarDespesaEmpresa,
    criarCategoriaComSubcategoria,
    adicionarSubcategoriaEmCategoriaExistente,
    formatarConfirmacao,
    formatarBR,
}
