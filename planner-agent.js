// ─────────────────────────────────────────────────────────────────────────────
// planner-agent.js — Cadastro de despesas no Meu Planner Financeiro (browser VISÍVEL,
// perfil persistente, login manual). Usado pela Zaya quando o dono manda uma despesa
// pelo WhatsApp.
//
// - Navegador SEMPRE visível (headless: false) — o dono acompanha na tela.
// - Perfil persistente próprio (planner_profile/) — NUNCA reusa o shopee_profile.
// - Login manual na 1ª vez (e sempre que a sessão expirar). NENHUMA senha no código/.env.
// - Reaproveita launchBrowser + resolverChrome do shopee-agent.js (não duplica).
// - Browser fica ABERTO entre lançamentos; reabre sozinho se fechar.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config()

const fs = require('fs')
const path = require('path')
const Groq = require('groq-sdk')
const { launchBrowser, resolverChrome } = require('./shopee-agent')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const PLANNER_URL = process.env.PLANNER_URL || 'https://web.meuplannerfinanceiro.com.br/login'
const PLANNER_BASE = 'https://web.meuplannerfinanceiro.com.br'
const LANCAMENTOS_URL = `${PLANNER_BASE}/controle/lancamentos`
const BALANCO_MENSAL_URL = `${PLANNER_BASE}/controle/balanco-mensal`

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

    console.log('🌐 [Planner] Abrindo navegador visível (perfil planner_profile)...')
    plannerBrowser = await launchBrowser(resolverChrome(), { userDataDir: PROFILE_DIR, headless: false })

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

// Detecta se a página está pedindo login (URL /login ou campo de senha visível)
async function precisaLogin(page) {
    try {
        if (/\/login|\/entrar|\/signin/i.test(page.url())) return true
        return await page.evaluate(() => {
            if (document.querySelector('input[type="password"]')) return true
            const t = (document.body?.innerText || '').toLowerCase()
            // "Entrar"/"Login" só conta como tela de login se NÃO houver conteúdo do app
            const temApp = document.querySelector('table, [class*="sidebar" i], nav')
            return !temApp && /\b(entrar|fazer login|acessar sua conta)\b/.test(t)
        }).catch(() => false)
    } catch { return true }
}

// Garante que a sessão está logada. Se cair na tela de login, PAUSA e aguarda o dono
// logar manualmente (timeout de 5 min). onStatus opcional avisa o dono pelo WhatsApp.
async function garantirLogado(page, onStatus) {
    await page.goto(LANCAMENTOS_URL, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {})
    await esperar(2000)
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
    await esperar(3000)
    await fecharModaisPromocionais(page)
    await esperar(2000)
    await page.screenshot({ path: path.join(DEBUG_DIR, 'antes_clicar_novo.png') }).catch(() => {})

    const r = await page.evaluate(() => {
        const cands = [...document.querySelectorAll('button, a, [role="button"]')].filter(el => el.offsetParent !== null)
        const txt = el => (el.textContent || '').trim()
        let alvo = cands.find(b => /^[+＋]$/.test(txt(b)))
        if (!alvo) {
            alvo = cands.find(b => {
                const c = b.className?.baseVal || b.className || ''
                const a = b.getAttribute('aria-label') || ''
                return /add|plus|novo/i.test(c) || /add|plus|novo/i.test(a)
            })
        }
        if (!alvo) {
            alvo = cands.filter(b => {
                const rect = b.getBoundingClientRect()
                return rect.top > 0 && rect.top < 250 && rect.left < 400 && rect.width > 0 && rect.height > 0
            }).sort((a, b2) => {
                const ra = a.getBoundingClientRect(), rb = b2.getBoundingClientRect()
                return (ra.top - rb.top) || (ra.left - rb.left)
            })[0]
        }
        if (!alvo) return { ok: false, visiveis: cands.slice(0, 25).map(txt).filter(Boolean) }
        alvo.scrollIntoView({ block: 'center' })
        alvo.click()
        return { ok: true, texto: txt(alvo) }
    })

    if (!r.ok) {
        await page.screenshot({ path: path.join(DEBUG_DIR, 'botao_novo_nao_encontrado.png') }).catch(() => {})
        console.log(`🔍 [Planner] Botões visíveis: ${JSON.stringify(r.visiveis)}`)
        throw new Error('Botão "+" de novo lançamento não encontrado (veja debug_planner/antes_clicar_novo.png)')
    }
    console.log(`🖱️  [Planner] Cliquei em "${r.texto}" — abrindo linha de lançamento`)
    await esperar(2000)
}

async function preencherLinhaLancamento(page, dados) {
    const dataBR = dataParaBR(dados.data)
    const linha = await page.evaluateHandle(() => document.querySelector('table tbody tr'))
    const elLinha = linha.asElement()
    if (!elLinha) {
        await page.screenshot({ path: path.join(DEBUG_DIR, 'linha_nao_encontrada.png') }).catch(() => {})
        throw new Error('Linha inline de lançamento não encontrada (veja debug_planner/linha_nao_encontrada.png)')
    }
    const celulas = await elLinha.$$('td')
    if (celulas.length < 8) {
        await page.screenshot({ path: path.join(DEBUG_DIR, 'linha_celulas_insuficientes.png') }).catch(() => {})
        throw new Error(`Linha com apenas ${celulas.length} célula(s) — esperado ≥ 8`)
    }

    async function digitar(celula, valor) {
        const input = await celula.$('input')
        if (!input) throw new Error('Input não encontrado na célula')
        await input.click({ clickCount: 3 })
        await page.keyboard.press('Backspace')
        await input.type(String(valor), { delay: 50 })
    }

    async function selecionar(celula, textoOpcao) {
        const select = await celula.$('select')
        if (select) {
            const ok = await page.evaluate((el, texto) => {
                const opt = [...el.options].find(o => o.textContent.trim().toLowerCase() === texto.toLowerCase())
                if (!opt) return false
                el.value = opt.value
                el.dispatchEvent(new Event('change', { bubbles: true }))
                return true
            }, select, textoOpcao)
            if (!ok) throw new Error(`Opção "${textoOpcao}" não encontrada no <select>`)
            return
        }
        const gatilho = (await celula.$('input, [role="combobox"], [role="button"], div, span')) || celula
        await gatilho.click()
        await esperar(600)
        const ok = await page.evaluate((texto) => {
            const opcoes = [...document.querySelectorAll('[role="option"], li, [class*="option" i]')].filter(o => o.offsetParent !== null)
            const opt = opcoes.find(o => o.textContent.trim().toLowerCase() === texto.toLowerCase())
            if (!opt) return false
            opt.click()
            return true
        }, textoOpcao)
        if (!ok) throw new Error(`Opção "${textoOpcao}" não encontrada no dropdown`)
    }

    // [0] data evento, [1] data efetivação, [2] categoria, [3] subcategoria,
    // [4] inst. financeira (mantém), [5] descrição, [6] valor, [7] status
    await digitar(celulas[0], dataBR)
    await esperar(300)
    await digitar(celulas[1], dataBR)
    await esperar(300)
    await selecionar(celulas[2], dados.categoria)
    await esperar(800) // subcategorias dependem da categoria
    if (dados.subcategoria) {
        try { await selecionar(celulas[3], dados.subcategoria) } catch (e) {
            console.log(`⚠️  [Planner] Subcategoria "${dados.subcategoria}" não selecionada: ${e.message}`)
        }
        await esperar(300)
    }
    await digitar(celulas[5], dados.descricao)
    await esperar(200)
    await digitar(celulas[6], String(dados.valor.toFixed(2)).replace('.', ','))
    await esperar(200)
    try { await selecionar(celulas[7], 'Concluído') } catch {}
    await page.screenshot({ path: path.join(DEBUG_DIR, 'linha_preenchida.png') }).catch(() => {})
}

async function salvarLancamento(page) {
    const r = await page.evaluate(() => {
        const linha = document.querySelector('table tbody tr')
        if (!linha) return { ok: false, motivo: 'linha não encontrada' }
        const cands = [...linha.querySelectorAll('button, a, [role="button"], svg, i')].filter(el => el.offsetParent !== null)
        const txt = el => (el.textContent || '').trim()
        let alvo = cands.find(el => /^[✓✔√]$/.test(txt(el)))
        if (!alvo) {
            alvo = cands.find(el => {
                const c = el.className?.baseVal || el.className || ''
                const a = el.getAttribute('aria-label') || ''
                return /check|confirm|salvar|success/i.test(c) || /check|confirm|salvar/i.test(a)
            })
        }
        if (!alvo) {
            const verdes = cands.filter(el => {
                const cor = getComputedStyle(el).color || ''
                return /rgb\(\s*\d{1,2}\s*,\s*1[5-9]\d\s*,\s*\d{1,3}\s*\)/.test(cor) || /green/i.test(cor)
            })
            alvo = verdes.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0]
        }
        if (!alvo) return { ok: false, motivo: 'botão ✓ não encontrado' }
        const clic = alvo.closest('button, a, [role="button"]') || alvo
        clic.scrollIntoView({ block: 'center' })
        clic.click()
        return { ok: true }
    })
    if (!r.ok) {
        await page.screenshot({ path: path.join(DEBUG_DIR, 'botao_salvar_nao_encontrado.png') }).catch(() => {})
        throw new Error('Botão "✓" de salvar não encontrado (veja debug_planner/botao_salvar_nao_encontrado.png)')
    }
    await esperar(3000)
    await page.screenshot({ path: path.join(DEBUG_DIR, 'apos_salvar.png') }).catch(() => {})

    // Confirma "Lançamento criado com sucesso" (toast) — não bloqueia se não achar
    const sucesso = await page.evaluate(() => {
        const t = (document.body?.innerText || '').toLowerCase()
        return /lançamento (criado|salvo|adicionado)|criado com sucesso|salvo com sucesso/.test(t)
    }).catch(() => false)
    return sucesso
}

// Lê o valor realizado de uma categoria/subcategoria no Balanço Mensal (best-effort)
async function lerRealizado(page, nome) {
    return await page.evaluate((alvo) => {
        const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase()
        const linhas = [...document.querySelectorAll('table tbody tr, [class*="row" i]')]
        const linha = linhas.find(l => norm(l.textContent).includes(norm(alvo)))
        if (!linha) return null
        const texto = linha.textContent.replace(/\s+/g, ' ')
        const vals = [...texto.matchAll(/R?\$?\s*([\d.]{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/g)]
            .map(m => Number(m[1].replace(/\./g, '').replace(',', '.')))
            .filter(Number.isFinite)
        return vals.length ? vals[0] : null
    }, nome)
}

async function lerBalancoMensal(page, categoria, subcategoria) {
    await page.goto(BALANCO_MENSAL_URL, { waitUntil: 'networkidle2', timeout: 40000 }).catch(() => {})
    await esperar(3000)
    await fecharModaisPromocionais(page)
    await page.screenshot({ path: path.join(DEBUG_DIR, 'balanco_mensal.png') }).catch(() => {})

    const realizadoCat = await lerRealizado(page, categoria)
    const realizadoSub = subcategoria ? await lerRealizado(page, subcategoria) : null
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
