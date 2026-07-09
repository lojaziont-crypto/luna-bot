// ─────────────────────────────────────────────────────────────────────────────
// planner-agent.js — Cadastro de despesas no Meu Planner Financeiro (browser VISÍVEL,
// perfil persistente, login manual). Usado pela Zaya quando o dono manda uma despesa
// pelo WhatsApp.
//
// - Navegador SEMPRE visível (headless: false) — o dono acompanha na tela.
// - Perfil persistente próprio (planner_profile/) — NUNCA reusa o shopee_profile.
// - Login manual na 1ª vez (e sempre que a sessão expirar). NENHUMA senha no código/.env.
// - Usa puppeteer puro (não extra) — planner não precisa de stealth; resolverChrome vem do shopee-agent.
// - Browser fica ABERTO entre lançamentos; reabre sozinho se fechar.
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

const PROFILE_DIR = path.join(__dirname, 'planner_profile')
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

// Descrição legível das categorias/subcategorias para o prompt do Groq
function descreverCategorias() {
    const linhas = []
    for (const [cat, info] of Object.entries(PLANEJAMENTO)) {
        const subs = Object.keys(info.subs)
        linhas.push(subs.length ? `- ${cat}: ${subs.join(', ')}` : `- ${cat} (sem subcategoria)`)
    }
    return linhas.join('\n')
}

// ───────────────────────── Utilidades ─────────────────────────

const esperar = ms => new Promise(r => setTimeout(r, ms))

function dataParaBR(dataISO) {
    const [ano, mes, dia] = dataISO.split('-')
    return `${dia}/${mes}/${ano}`
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

const PROMPT_DESPESA = `Você interpreta mensagens em texto livre do dono de uma loja, que registra gastos pessoais.
Extraia os dados da despesa mencionada.

CATEGORIAS E SUBCATEGORIAS DE DESPESA VÁLIDAS (use EXATAMENTE estes nomes):
${descreverCategorias()}

Categorias de RECEITA válidas (só se a mensagem for claramente um recebimento): ${RECEITAS.join(', ')}

REGRAS:
- valor: número decimal com ponto (ex: 12.82). Aceite vírgula ou ponto na entrada.
- categoria: escolha EXATAMENTE uma da lista acima. Se a palavra citada for uma subcategoria (ex: "lanche", "internet", "uber"), deduza a categoria pai correta.
- subcategoria: preencha SOMENTE se a categoria tiver subcategorias e você identificar qual. Caso contrário, "".
- descricao: breve, baseada na mensagem (ex: "Lanche", "Conta de internet").
- data: AAAA-MM-DD. Use a data de hoje informada se não houver outra data clara.
- confianca: número de 0 a 1 indicando o quão seguro você está da categoria. Use < 0.6 se estiver em dúvida sobre a categoria.

Responda EXCLUSIVAMENTE em JSON, sem texto fora do JSON:
{"valor": 0.00, "categoria": "...", "subcategoria": "...", "descricao": "...", "data": "AAAA-MM-DD", "confianca": 0.0}`

// Retorna { ok, dados?, motivo? }. dados = { valor, categoria, subcategoria, descricao, data, confianca }
async function interpretarDespesa(texto) {
    const hoje = new Date().toISOString().slice(0, 10)
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

    const confianca = Number(bruto.confianca)
    const data = /^\d{4}-\d{2}-\d{2}$/.test(bruto.data || '') ? bruto.data : hoje
    const descricao = (bruto.descricao || subcategoria || categoria).toString().slice(0, 120)

    const dados = { valor, categoria, subcategoria, descricao, data, confianca: Number.isFinite(confianca) ? confianca : 0.5 }

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

// Fecha modais promocionais que cobrem a tela (mesma lógica validada no finn.js)
async function fecharModaisPromocionais(page) {
    for (let i = 0; i < 3; i++) {
        const fechou = await page.evaluate(() => {
            const modais = [...document.querySelectorAll('[class*="modal" i], [role="dialog"], [class*="overlay" i]')]
                .filter(el => el.offsetParent !== null)
            for (const modal of modais) {
                const btn = [...modal.querySelectorAll('button, [class*="close" i], svg, span')]
                    .find(el => /^[x×✕]$/i.test(el.textContent.trim()) || /close|fechar/i.test(el.className?.baseVal || el.className || ''))
                if (btn) { btn.click(); return true }
            }
            return false
        }).catch(() => false)
        if (!fechou) break
        await esperar(700)
    }
    await page.keyboard.press('Escape').catch(() => {})
    await esperar(400)
}

// Detecta se a página está pedindo login aguardando o SPA montar.
// Promise.race: quem aparecer primeiro — campo de senha (login) ou elemento do app (logado).
// Timeout de 10s → fallback pela URL (evita falso-positivo com React ainda carregando).
async function precisaLogin(page) {
    try {
        const SEL_LOGIN = 'input[type="password"]'
        const SEL_APP   = 'table, nav, [class*="sidebar" i], [class*="menu" i], [class*="layout" i]'
        const resultado = await Promise.race([
            page.waitForSelector(SEL_LOGIN, { timeout: 10000 }).then(() => true),
            page.waitForSelector(SEL_APP,   { timeout: 10000 }).then(() => false),
        ]).catch(() => /\/login|\/entrar|\/signin/i.test(page.url()))
        return resultado
    } catch { return true }
}

// Garante que a sessão está logada. Se cair na tela de login, PAUSA e aguarda o dono
// logar manualmente (timeout de 5 min). onStatus opcional avisa o dono pelo WhatsApp.
async function garantirLogado(page, onStatus) {
    await page.goto(LANCAMENTOS_URL, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {})
    await fecharModaisPromocionais(page)

    if (!(await precisaLogin(page))) return

    // Vai para a tela de login para o dono ver e digitar
    await page.goto(PLANNER_URL, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {})
    console.log('⏸️  [Planner] Tela de login detectada — aguardando login manual (até 5 min)...')
    if (onStatus) onStatus('🔐 Abri o navegador do Planner na tela de login. Faça o login manualmente — assim que entrar, eu continuo o cadastro. (aguardo até 5 min)')

    const inicio = Date.now()
    while (Date.now() - inicio < TIMEOUT_LOGIN_MS) {
        await esperar(3000)
        if (!(await precisaLogin(page))) {
            console.log('✅ [Planner] Login manual concluído — sessão salva em planner_profile.')
            await esperar(1500)
            await fecharModaisPromocionais(page)
            return
        }
    }
    throw new Error('LOGIN_TIMEOUT')
}

// ───────────────────────── Fluxo de cadastro (seletores validados no finn.js) ─────────────────────────

async function abrirNovoLancamento(page) {
    await page.goto(LANCAMENTOS_URL, { waitUntil: 'networkidle2', timeout: 40000 })
    await esperar(2000)
    await fecharModaisPromocionais(page)
    await page.screenshot({ path: path.join(DEBUG_DIR, 'antes_clicar_novo.png') }).catch(() => {})

    // Clica no botão "+" (primeiro botão visível no cabeçalho da tabela)
    const r = await page.evaluate(() => {
        const cands = [...document.querySelectorAll('button, a, [role="button"]')]
            .filter(el => el.offsetParent !== null)
        const txt = el => (el.textContent || '').trim()
        // Prioridade 1: botão com texto exato "+"
        let alvo = cands.find(b => /^[+＋]$/.test(txt(b)))
        // Prioridade 2: atributo aria-label de adicionar
        if (!alvo) alvo = cands.find(b => /add|plus|novo|criar/i.test(b.getAttribute('aria-label') || ''))
        // Prioridade 3: primeiro botão pequeno no topo da página (área do cabeçalho)
        if (!alvo) {
            alvo = cands.filter(b => {
                const r = b.getBoundingClientRect()
                return r.top > 0 && r.top < 200 && r.left < 100 && r.width > 0
            })[0]
        }
        if (!alvo) return { ok: false, visiveis: cands.slice(0, 20).map(txt).filter(Boolean) }
        alvo.scrollIntoView({ block: 'center' })
        alvo.click()
        return { ok: true, texto: txt(alvo) }
    })

    if (!r.ok) {
        await page.screenshot({ path: path.join(DEBUG_DIR, 'botao_novo_nao_encontrado.png') }).catch(() => {})
        console.log(`🔍 [Planner] Botões visíveis: ${JSON.stringify(r.visiveis)}`)
        throw new Error('Botão "+" de novo lançamento não encontrado')
    }
    console.log(`🖱️  [Planner] Cliquei em "${r.texto}" — aguardando linha inline...`)

    // Aguarda a linha inline aparecer (input[type="date"] visível)
    await page.waitForFunction(
        () => [...document.querySelectorAll('input[type="date"]')].some(el => el.offsetParent !== null),
        { timeout: 8000 }
    ).catch(() => {})
    await esperar(500)
}

async function preencherLinhaLancamento(page, dados) {
    // O TR da linha inline tem input[type="date"] — sobe 3 níveis: input > label > td > tr
    const elLinha = await page.evaluateHandle(() => {
        const dateInp = [...document.querySelectorAll('input[type="date"]')]
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
    // td[4]=subcategoria, td[5]=inst.financeira(skip), td[6]=cartão(skip),
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
    }
    await setarInput(celulas[7], dados.descricao)
    await esperar(200)
    await setarInput(celulas[8], String(dados.valor.toFixed(2)).replace('.', ','))
    await esperar(200)
    try { await selecionar(celulas[9], 'Concluído') } catch {}
    await page.screenshot({ path: path.join(DEBUG_DIR, 'linha_preenchida.png') }).catch(() => {})
}

async function salvarLancamento(page) {
    // O botão de salvar é button[type="submit"] dentro do TR de edição
    const ok = await page.evaluate(() => {
        const dateInp = [...document.querySelectorAll('input[type="date"]')]
            .find(el => el.offsetParent !== null)
        const tr = dateInp?.parentElement?.parentElement?.parentElement
        if (!tr) return false
        const btn = [...tr.querySelectorAll('button')].find(b => b.type === 'submit')
        if (!btn) return false
        btn.click()
        return true
    })
    if (!ok) {
        await page.screenshot({ path: path.join(DEBUG_DIR, 'botao_salvar_nao_encontrado.png') }).catch(() => {})
        throw new Error('Botão submit de salvar não encontrado (veja debug_planner/botao_salvar_nao_encontrado.png)')
    }
    await esperar(3000)
    await page.screenshot({ path: path.join(DEBUG_DIR, 'apos_salvar.png') }).catch(() => {})

    const sucesso = await page.evaluate(() => {
        const t = (document.body?.innerText || '').toLowerCase()
        return /lançamento (criado|salvo|adicionado)|criado com sucesso|salvo com sucesso/.test(t)
    }).catch(() => false)
    return sucesso
}

async function lerBalancoMensal(page, categoria, subcategoria) {
    await page.goto(BALANCO_MENSAL_URL, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {})
    await esperar(3000)
    await fecharModaisPromocionais(page)
    await page.screenshot({ path: path.join(DEBUG_DIR, 'balanco_mensal.png') }).catch(() => {})

    // Lê realizados da seção "DESPESAS: REALIZADO VS PLANEJADO" via innerText
    // Formato: CATEGORIA\nX.X%\nR$ Y,YY (repetido para cada categoria)
    const realizados = await page.evaluate(() => {
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

    const norm = s => (s || '').trim().toLowerCase()
    const realizadoCat = realizados[norm(categoria)] ?? null
    // Subcategoria: usa o total da categoria como proxy (o dashboard não expõe sub-realizado individualmente)
    const realizadoSub = subcategoria ? realizadoCat : null
    return { realizadoCat, realizadoSub }
}

// ───────────────────────── Orquestração ─────────────────────────

// Cadastra a despesa já interpretada. onStatus(msg) opcional avisa o dono pelo WhatsApp
// durante etapas longas (ex: aguardando login manual).
// Retorna: { sucesso, valorLancado, categoria, subcategoria, descricao,
//            realizado, planejado, percentual, limiteRestante,
//            realizadoSub, planejadoSub, restanteSub }
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

        const info = PLANEJAMENTO[dados.categoria] || { limite: null, subs: {} }
        const planejado = info.limite
        const planejadoSub = dados.subcategoria ? info.subs[dados.subcategoria] : null

        let realizado = null, realizadoSub = null
        try {
            const bal = await lerBalancoMensal(page, dados.categoria, dados.subcategoria)
            realizado = bal.realizadoCat
            realizadoSub = bal.realizadoSub
        } catch (e) {
            console.log(`⚠️  [Planner] Não consegui ler o Balanço Mensal: ${e.message}`)
        }

        // Fallback: se o balanço não trouxe o realizado, usa ao menos o valor lançado agora
        if (realizado == null) realizado = dados.valor
        if (dados.subcategoria && realizadoSub == null) realizadoSub = dados.valor

        const percentual = (planejado && planejado > 0) ? (realizado / planejado) * 100 : null
        const limiteRestante = (planejado != null) ? (planejado - realizado) : null
        const restanteSub = (planejadoSub != null && realizadoSub != null) ? (planejadoSub - realizadoSub) : null

        return {
            sucesso: true,
            confirmadoToast: okSucesso,
            valorLancado: dados.valor,
            categoria: dados.categoria,
            subcategoria: dados.subcategoria || null,
            descricao: dados.descricao,
            realizado, planejado, percentual, limiteRestante,
            realizadoSub, planejadoSub, restanteSub,
        }
    } finally {
        ocupado = false
    }
}

// Monta a mensagem de WhatsApp a partir do resultado de cadastrarDespesa
function formatarRespostaWhatsApp(r) {
    const nomeItem = r.subcategoria || r.categoria
    let msg = `✅ Despesa cadastrada: R$ ${formatarBR(r.valorLancado)} em ${nomeItem}`

    if (r.planejado != null) {
        const pct = r.percentual != null ? ` (${formatarBR(r.percentual)}%)` : ''
        msg += `\n📊 ${r.categoria} este mês: R$ ${formatarBR(r.realizado)} de R$ ${formatarBR(r.planejado)}${pct}`
    } else {
        msg += `\n📊 ${r.categoria}: sem limite planejado definido`
    }

    if (r.subcategoria && r.planejadoSub != null && r.restanteSub != null) {
        msg += `\n💰 Limite restante em ${r.subcategoria}: R$ ${formatarBR(r.restanteSub)} de R$ ${formatarBR(r.planejadoSub)}`
    } else if (r.limiteRestante != null) {
        msg += `\n💰 Limite restante em ${r.categoria}: R$ ${formatarBR(r.limiteRestante)} de R$ ${formatarBR(r.planejado)}`
    }
    return msg
}

module.exports = {
    interpretarDespesa,
    cadastrarDespesa,
    formatarRespostaWhatsApp,
    abrirPlannerBrowser,
    PLANEJAMENTO,
    CATEGORIAS_DESPESA,
}
