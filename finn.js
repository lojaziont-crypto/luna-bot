require('dotenv').config()

process.on('uncaughtException', (err) => {
    console.error('[ERRO FATAL]', err.message)
})
process.on('unhandledRejection', (err) => {
    console.error('[PROMISE REJEITADA]', err?.message || err)
})

const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const cron = require('node-cron')
const Groq = require('groq-sdk')
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())
const { resolverChrome } = require('./shopee-agent')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const PLANNER_URL = 'https://web.meuplannerfinanceiro.com.br'
const LANCAMENTOS_URL = `${PLANNER_URL}/controle/lancamentos`
const PENDENCIAS_URL = `${PLANNER_URL}/controle/pendencias`
const BALANCO_MENSAL_URL = `${PLANNER_URL}/controle/balanco-mensal`
const PROFILE_DIR = path.join(__dirname, 'finn_profile')
// Perfil separado só para o navegador visível de inspeção (/abrir-planner) — usar o
// mesmo PROFILE_DIR do browser headless faz o Chrome detectar "perfil em uso" (lock
// do Singleton) e fechar a janela quase instantaneamente
const INSPECAO_PROFILE_DIR = path.join(__dirname, 'finn_profile_inspecao')
const DEBUG_DIR = path.join(__dirname, 'debug_finn')
const LIMITES_FILE = path.join(__dirname, 'finn_limites.json')
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR)

const CATEGORIAS = ['Alimentação', 'Casa', 'Transporte', 'Farmácia', 'Cuidados Pessoais', 'Vestuário', 'Academia', 'Renda Extra', 'Outros']

let browserOcupado = false // mutex: nunca abre dois browsers ao mesmo tempo (mesma lógica do zyon.js)

function carregarJSON(arquivo, padrao) {
    try {
        if (fs.existsSync(arquivo)) return JSON.parse(fs.readFileSync(arquivo, 'utf8'))
    } catch {}
    return padrao
}
function salvarJSON(arquivo, dados) {
    fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2))
}

let limites = carregarJSON(LIMITES_FILE, {})

function launchBrowser(executablePath) {
    return puppeteer.launch({
        headless: 'new',
        executablePath,
        userDataDir: PROFILE_DIR,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--window-size=1366,768',
            '--lang=pt-BR',
        ],
    })
}

// ───────────────────────── Notificação à Zaya ─────────────────────────

function notificarZaya(mensagem) {
    const url = process.env.ZAYA_URL
    if (!url) {
        console.log(`⚠️  [Finn] ZAYA_URL não definida — mensagem não enviada: ${mensagem}`)
        return
    }

    const data = JSON.stringify({ mensagem })
    let parsedUrl
    try { parsedUrl = new URL(`${url}/finn-notificacao`) } catch {
        console.error(`❌ [Finn] ZAYA_URL inválida: ${url}`)
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
        console.log(`📨 [Finn] Zaya notificada (HTTP ${res.statusCode})`)
    })
    req.on('error', err => console.error(`❌ [Finn] Erro ao notificar Zaya: ${err.message}`))
    req.write(data)
    req.end()
}

// ───────────────────────── Extração via Groq ─────────────────────────

const PROMPT_EXTRACAO = `Você é Finn, um agente financeiro que extrai dados de lançamentos a partir de comprovantes (imagem) ou descrições em texto enviadas pelo dono da loja.

A partir do conteúdo informado, extraia os seguintes campos:
- descricao: breve descrição do lançamento (ex: "Almoço no restaurante", "Conta de luz")
- valor: valor numérico do lançamento (apenas número, com ponto decimal, sem símbolo de moeda — ex: 45.90)
- categoria: escolha exatamente UMA destas opções: ${CATEGORIAS.join(', ')}
- subcategoria: uma subcategoria coerente com a categoria escolhida e com a descrição (ex: categoria "Alimentação" → subcategoria "Restaurante" ou "Supermercado")
- data: data do lançamento no formato AAAA-MM-DD — use a data de hoje informada abaixo se não houver indicação clara de outra data
- status: "Concluído" por padrão. Use "Pendente" SOMENTE quando houver indicação clara de vencimento futuro (ex: "vence dia 15", "boleto para pagar até X", conta com data de vencimento posterior a hoje)

Responda EXCLUSIVAMENTE em JSON, neste formato exato (sem texto fora do JSON):
{"descricao": "...", "valor": 0.00, "categoria": "...", "subcategoria": "...", "data": "AAAA-MM-DD", "status": "Concluído ou Pendente"}`

function parseExtracao(conteudo) {
    try {
        const dados = JSON.parse(conteudo)
        dados.valor = Number(dados.valor)
        return dados
    } catch (err) {
        throw new Error(`IA não retornou JSON válido na extração: ${err.message}`)
    }
}

async function extrairDeTexto(texto) {
    const hoje = new Date().toISOString().slice(0, 10)
    const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: `${PROMPT_EXTRACAO}\n\nData de hoje: ${hoje}` },
            { role: 'user', content: texto },
        ],
    })
    return parseExtracao(response.choices[0].message.content)
}

async function extrairDeImagem(imagemBase64, mimeType, texto) {
    const hoje = new Date().toISOString().slice(0, 10)
    const dataUri = `data:${mimeType || 'image/jpeg'};base64,${imagemBase64}`
    const response = await groq.chat.completions.create({
        model: 'llama-3.2-90b-vision-preview',
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: `${PROMPT_EXTRACAO}\n\nData de hoje: ${hoje}` },
            {
                role: 'user',
                content: [
                    { type: 'text', text: texto || 'Extraia os dados do lançamento a partir deste comprovante.' },
                    { type: 'image_url', image_url: { url: dataUri } },
                ],
            },
        ],
    })
    return parseExtracao(response.choices[0].message.content)
}

async function extrairLancamento({ imagemBase64, mimeType, texto }) {
    if (imagemBase64) return extrairDeImagem(imagemBase64, mimeType, texto)
    if (!texto) throw new Error('Nenhum texto ou imagem informado para extração')
    return extrairDeTexto(texto)
}

// ───────────────────────── Automação do Planner (Puppeteer) ─────────────────────────

// Fecha modais promocionais ("Upgrade para Plano Premium" etc.) que o Planner exibe
// ao entrar — eles cobrem a tela e bloqueiam cliques nos elementos reais da página
// se não forem fechados antes de prosseguir (ex: botão "Novo lançamento")
async function fecharModaisPromocionais(page) {
    for (let tentativa = 0; tentativa < 3; tentativa++) {
        const fechou = await page.evaluate(() => {
            const modais = [...document.querySelectorAll('[class*="modal" i], [role="dialog"], [class*="overlay" i]')]
                .filter(el => el.offsetParent !== null)
            for (const modal of modais) {
                const botaoFechar = [...modal.querySelectorAll('button, [class*="close" i], svg, span')]
                    .find(el => /^[x×✕]$/i.test(el.textContent.trim()) || /close|fechar/i.test(el.className?.baseVal || el.className || ''))
                if (botaoFechar) { botaoFechar.click(); return true }
            }
            return false
        })
        if (!fechou) break
        console.log('🗙 [Finn] Modal promocional fechado')
        await new Promise(r => setTimeout(r, 800))
    }
    await page.keyboard.press('Escape').catch(() => {})
    await new Promise(r => setTimeout(r, 500))
}

async function fazerLogin(page) {
    await page.goto(PLANNER_URL, { waitUntil: 'networkidle2', timeout: 30000 })
    await new Promise(r => setTimeout(r, 2000))

    // Sessão persistida em finn_profile — se já não houver campo de senha, está logado
    const precisaLogar = await page.evaluate(() => !!document.querySelector('input[type="password"]'))
    if (!precisaLogar) {
        console.log('🔓 [Finn] Sessão já autenticada no Planner')
        return
    }

    console.log('🔐 [Finn] Fazendo login no Planner...')
    const campoEmail = await page.$('input[type="email"], input[name*="email" i], input[id*="email" i]')
    const campoSenha = await page.$('input[type="password"]')
    if (!campoEmail || !campoSenha) {
        await page.screenshot({ path: path.join(DEBUG_DIR, 'login_campos_nao_encontrados.png') })
        throw new Error('Campos de login não encontrados — veja debug_finn/login_campos_nao_encontrados.png')
    }

    await campoEmail.click({ clickCount: 3 })
    await campoEmail.type(process.env.PLANNER_EMAIL, { delay: 50 })
    await campoSenha.click({ clickCount: 3 })
    await campoSenha.type(process.env.PLANNER_PASSWORD, { delay: 50 })

    const botaoEntrar = await page.evaluateHandle(() => {
        return [...document.querySelectorAll('button, input[type="submit"]')]
            .find(b => /entrar|login|acessar/i.test(b.textContent || b.value || ''))
    })
    const elBotaoEntrar = botaoEntrar.asElement()
    if (elBotaoEntrar) await elBotaoEntrar.click()
    else await page.keyboard.press('Enter')

    await new Promise(r => setTimeout(r, 5000))
    await page.screenshot({ path: path.join(DEBUG_DIR, 'apos_login.png') })

    const aindaNoLogin = await page.evaluate(() => !!document.querySelector('input[type="password"]'))
    if (aindaNoLogin) {
        throw new Error('Login no Planner falhou — veja debug_finn/apos_login.png')
    }
    console.log('✅ [Finn] Login no Planner concluído')

    await fecharModaisPromocionais(page)
}

// Abre o formulário de novo lançamento. Na tela /controle/lancamentos, o botão "+" fica
// no canto superior esquerdo e, ao ser clicado, insere uma LINHA INLINE EDITÁVEL como
// primeira linha da tabela (não abre modal/formulário separado).
async function abrirNovoLancamento(page) {
    await page.goto(LANCAMENTOS_URL, { waitUntil: 'networkidle2', timeout: 30000 })
    await new Promise(r => setTimeout(r, 3000))
    await fecharModaisPromocionais(page)
    await new Promise(r => setTimeout(r, 2500)) // tempo extra para a página assentar após fechar o modal

    await page.screenshot({ path: path.join(DEBUG_DIR, 'antes_clicar_novo.png') })

    const resultado = await page.evaluate(() => {
        const candidatos = [...document.querySelectorAll('button, a, [role="button"]')]
            .filter(el => el.offsetParent !== null) // só elementos visíveis
        const textoDe = el => (el.textContent || '').trim()

        // 1) Texto exatamente "+" (com variantes de glifo)
        let alvo = candidatos.find(b => /^[+＋]$/.test(textoDe(b)))

        // 2) Ícone/aria-label/classe indicando "adicionar"/"novo"/"plus"
        if (!alvo) {
            alvo = candidatos.find(b => {
                const classe = b.className?.baseVal || b.className || ''
                const aria = b.getAttribute('aria-label') || ''
                return /add|plus|novo/i.test(classe) || /add|plus|novo/i.test(aria)
            })
        }

        // 3) Por posição: primeiro botão visível no canto superior esquerdo da página
        if (!alvo) {
            alvo = candidatos
                .filter(b => {
                    const r = b.getBoundingClientRect()
                    return r.top > 0 && r.top < 250 && r.left < 400 && r.width > 0 && r.height > 0
                })
                .sort((a, b2) => {
                    const ra = a.getBoundingClientRect(), rb = b2.getBoundingClientRect()
                    return (ra.top - rb.top) || (ra.left - rb.left)
                })[0]
        }

        if (!alvo) return { ok: false, opcoesVisiveis: candidatos.slice(0, 25).map(textoDe).filter(Boolean) }
        alvo.scrollIntoView({ block: 'center' })
        alvo.click()
        return { ok: true, textoClicado: textoDe(alvo) }
    })

    if (!resultado.ok) {
        await page.screenshot({ path: path.join(DEBUG_DIR, 'botao_novo_nao_encontrado.png') })
        console.log(`🔍 [Finn] Botões visíveis na tela: ${JSON.stringify(resultado.opcoesVisiveis)}`)
        throw new Error('Botão "+" de novo lançamento não encontrado — veja debug_finn/antes_clicar_novo.png e debug_finn/botao_novo_nao_encontrado.png')
    }

    console.log(`🖱️  [Finn] Clicou em "${resultado.textoClicado}" para abrir a linha de novo lançamento`)
    await new Promise(r => setTimeout(r, 2000))
    await page.screenshot({ path: path.join(DEBUG_DIR, 'apos_clicar_novo.png') })
}

// Converte data ISO (AAAA-MM-DD) para o formato brasileiro DD/MM/AAAA usado nos campos do Planner
function dataParaBR(dataISO) {
    const [ano, mes, dia] = dataISO.split('-')
    return `${dia}/${mes}/${ano}`
}

// Preenche a linha inline editável (primeira <tr> da tabela) célula por célula, na ordem
// real do Planner: [0] data do evento, [1] data efetivação, [2] categoria, [3] subcategoria,
// [4] inst. financeira (mantém padrão), [5] descrição, [6] valor, [7] status
async function preencherLinhaLancamento(page, dados) {
    const dataBR = dataParaBR(dados.data)

    const linha = await page.evaluateHandle(() => document.querySelector('table tbody tr'))
    const elLinha = linha.asElement()
    if (!elLinha) {
        await page.screenshot({ path: path.join(DEBUG_DIR, 'linha_nao_encontrada.png') })
        throw new Error('Linha inline de novo lançamento não encontrada — veja debug_finn/linha_nao_encontrada.png')
    }

    const celulas = await elLinha.$$('td')
    if (celulas.length < 8) {
        await page.screenshot({ path: path.join(DEBUG_DIR, 'linha_celulas_insuficientes.png') })
        throw new Error(`Linha de lançamento tem apenas ${celulas.length} célula(s) — esperado ao menos 8 (veja debug_finn/linha_celulas_insuficientes.png)`)
    }

    // Preenche um <input> de texto/data dentro da célula, simulando digitação real
    // (necessário porque muitos componentes de data ignoram setar .value diretamente)
    async function digitarNaCelula(celula, valor) {
        const input = await celula.$('input')
        if (!input) throw new Error('Input não encontrado na célula')
        await input.click({ clickCount: 3 })
        await page.keyboard.press('Backspace')
        await input.type(String(valor), { delay: 50 })
    }

    // Seleciona uma opção em dropdown — tenta <select> nativo, senão clica para abrir
    // a lista customizada e seleciona a opção pelo texto visível
    async function selecionarNaCelula(celula, textoOpcao) {
        const select = await celula.$('select')
        if (select) {
            const ok = await page.evaluate((el, texto) => {
                const opcao = [...el.options].find(o => o.textContent.trim().toLowerCase() === texto.toLowerCase())
                if (!opcao) return false
                el.value = opcao.value
                el.dispatchEvent(new Event('change', { bubbles: true }))
                return true
            }, select, textoOpcao)
            if (!ok) throw new Error(`Opção "${textoOpcao}" não encontrada no <select> da célula`)
            return
        }

        // Dropdown customizado: clica para abrir e escolhe a opção na lista que aparece
        const gatilho = (await celula.$('input, [role="combobox"], [role="button"], div, span')) || celula
        await gatilho.click()
        await new Promise(r => setTimeout(r, 600))
        const ok = await page.evaluate((texto) => {
            const opcoes = [...document.querySelectorAll('[role="option"], li, [class*="option" i]')]
                .filter(o => o.offsetParent !== null)
            const opcao = opcoes.find(o => o.textContent.trim().toLowerCase() === texto.toLowerCase())
            if (!opcao) return false
            opcao.click()
            return true
        }, textoOpcao)
        if (!ok) throw new Error(`Opção "${textoOpcao}" não encontrada no dropdown da célula`)
    }

    // [0] e [1] — data do evento e data de efetivação (mesmo valor)
    await digitarNaCelula(celulas[0], dataBR)
    await new Promise(r => setTimeout(r, 300))
    await digitarNaCelula(celulas[1], dataBR)
    await new Promise(r => setTimeout(r, 300))

    // [2] categoria
    await selecionarNaCelula(celulas[2], dados.categoria)
    await new Promise(r => setTimeout(r, 800)) // aguarda subcategorias carregarem (dependem da categoria)

    // [3] subcategoria
    await selecionarNaCelula(celulas[3], dados.subcategoria)
    await new Promise(r => setTimeout(r, 300))

    // [4] inst. financeira — mantém o valor padrão, não alteramos

    // [5] descrição
    await digitarNaCelula(celulas[5], dados.descricao)
    await new Promise(r => setTimeout(r, 200))

    // [6] valor
    await digitarNaCelula(celulas[6], String(dados.valor).replace('.', ','))
    await new Promise(r => setTimeout(r, 200))

    // [7] status — sempre "Concluído" por padrão (já vem assim na maioria dos casos)
    await selecionarNaCelula(celulas[7], dados.status)

    await page.screenshot({ path: path.join(DEBUG_DIR, 'linha_preenchida.png') })
}

// Salva a linha clicando no botão "✓" (checkmark verde) que aparece ao final da linha inline
async function salvarLancamento(page) {
    const resultado = await page.evaluate(() => {
        const linha = document.querySelector('table tbody tr')
        if (!linha) return { ok: false, motivo: 'linha não encontrada' }

        const candidatos = [...linha.querySelectorAll('button, a, [role="button"], svg, i')]
            .filter(el => el.offsetParent !== null)
        const textoDe = el => (el.textContent || '').trim()

        // 1) Texto/símbolo de check
        let alvo = candidatos.find(el => /^[✓✔√]$/.test(textoDe(el)))

        // 2) Ícone/classe/aria-label indicando "check"/"confirmar"/"salvar"
        if (!alvo) {
            alvo = candidatos.find(el => {
                const classe = el.className?.baseVal || el.className || ''
                const aria = el.getAttribute('aria-label') || ''
                return /check|confirm|salvar|success/i.test(classe) || /check|confirm|salvar/i.test(aria)
            })
        }

        // 3) Cor verde aplicada via estilo computado (último recurso, posicional —
        // o botão de confirmar fica no fim da linha, à direita)
        if (!alvo) {
            const verdes = candidatos.filter(el => {
                const cor = getComputedStyle(el).color || ''
                return /rgb\(\s*\d{1,2}\s*,\s*1[5-9]\d\s*,\s*\d{1,3}\s*\)/.test(cor) || /green/i.test(cor)
            })
            alvo = verdes.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0]
        }

        if (!alvo) return { ok: false, motivo: 'botão ✓ não encontrado', opcoesVisiveis: candidatos.slice(0, 20).map(textoDe).filter(Boolean) }

        // O elemento clicável pode ser o ícone (svg/i) — sobe até achar um botão/link/role=button
        const clicavel = alvo.closest('button, a, [role="button"]') || alvo
        clicavel.scrollIntoView({ block: 'center' })
        clicavel.click()
        return { ok: true }
    })

    if (!resultado.ok) {
        await page.screenshot({ path: path.join(DEBUG_DIR, 'botao_salvar_nao_encontrado.png') })
        console.log(`🔍 [Finn] ${resultado.motivo} — opções visíveis: ${JSON.stringify(resultado.opcoesVisiveis || [])}`)
        throw new Error('Botão "✓" de salvar não encontrado — veja debug_finn/botao_salvar_nao_encontrado.png')
    }

    await new Promise(r => setTimeout(r, 3000))
    await page.screenshot({ path: path.join(DEBUG_DIR, 'apos_salvar.png') })
}

// ───────────────────────── Verificação de limite por categoria (Balanço Mensal) ─────────────────────────

// Visita /controle/balanco-mensal e verifica se os gastos da categoria do lançamento
// estão próximos (≥80%) ou acima (≥100%) do limite definido para ela. Retorna uma
// string de alerta para incluir na notificação, ou null se não houver limite definido
// ou o gasto estiver dentro da faixa segura.
async function verificarLimiteCategoria(page, categoria) {
    const limite = limites[categoria]
    if (!limite || !Number.isFinite(limite)) return null

    try {
        await page.goto(BALANCO_MENSAL_URL, { waitUntil: 'networkidle2', timeout: 30000 })
        await new Promise(r => setTimeout(r, 3000))
        await fecharModaisPromocionais(page)
        await page.screenshot({ path: path.join(DEBUG_DIR, 'balanco_mensal.png') })

        const gastoAtual = await page.evaluate((nomeCategoria) => {
            const linhas = [...document.querySelectorAll('table tbody tr, [class*="row" i]')]
            const linha = linhas.find(l => l.textContent.toLowerCase().includes(nomeCategoria.toLowerCase()))
            if (!linha) return null

            const texto = linha.textContent.replace(/\s+/g, ' ')
            const valores = [...texto.matchAll(/R?\$?\s*([\d.]{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/g)]
                .map(m => Number(m[1].replace(/\./g, '').replace(',', '.')))
                .filter(Number.isFinite)

            return valores.length ? valores[0] : null
        }, categoria)

        if (gastoAtual === null) {
            console.log(`📊 [Finn] Categoria "${categoria}" não encontrada no Balanço Mensal — sem dado para comparar com o limite`)
            return null
        }

        const percentual = (gastoAtual / limite) * 100
        console.log(`📊 [Finn] Balanço — ${categoria}: R$ ${gastoAtual.toFixed(2)} de R$ ${limite.toFixed(2)} (${percentual.toFixed(0)}%)`)

        if (percentual >= 100) {
            return `🚨 *Limite estourado!* A categoria *${categoria}* já gastou R$ ${gastoAtual.toFixed(2)} de um limite de R$ ${limite.toFixed(2)} (${percentual.toFixed(0)}%).`
        }
        if (percentual >= 80) {
            return `⚠️ *Atenção:* a categoria *${categoria}* já gastou R$ ${gastoAtual.toFixed(2)} de um limite de R$ ${limite.toFixed(2)} (${percentual.toFixed(0)}%) — perto de estourar.`
        }
        return null
    } catch (err) {
        console.error('❌ [Finn] Erro ao verificar limite no Balanço Mensal:', err.message)
        return null
    }
}

// Abre o browser (respeitando o mutex), loga, registra o lançamento, verifica o limite
// da categoria e fecha — nunca dois browsers ao mesmo tempo (mesma lógica do zyon.js:
// variável browserOcupado)
async function registrarLancamentoNoPlanner(dados) {
    if (browserOcupado) {
        throw new Error('Browser ocupado por outra operação — tente novamente em instantes')
    }
    browserOcupado = true
    let browser
    try {
        browser = await launchBrowser(resolverChrome())
        const page = await browser.newPage()
        await page.setViewport({ width: 1366, height: 768 })
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' })

        await fazerLogin(page)
        await abrirNovoLancamento(page)
        await preencherLinhaLancamento(page, dados)
        await salvarLancamento(page)

        console.log(`✅ [Finn] Lançamento registrado no Planner: ${dados.descricao} — R$ ${dados.valor.toFixed(2)}`)

        const alertaLimite = await verificarLimiteCategoria(page, dados.categoria)
        return { alertaLimite }
    } finally {
        browserOcupado = false
        if (browser) { try { await browser.close() } catch {} }
    }
}

// ───────────────────────── Verificação diária de pendências (9h) ─────────────────────────

async function verificarPendenciasHoje() {
    if (browserOcupado) {
        console.log('⏭️  [Finn] Browser ocupado — verificação de pendências de hoje adiada')
        return
    }
    browserOcupado = true
    let browser
    try {
        console.log(`\n📋 [Finn] Verificando pendências que vencem hoje — ${new Date().toLocaleTimeString('pt-BR')}`)
        browser = await launchBrowser(resolverChrome())
        const page = await browser.newPage()
        await page.setViewport({ width: 1366, height: 768 })
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' })

        await fazerLogin(page)
        await page.goto(PENDENCIAS_URL, { waitUntil: 'networkidle2', timeout: 30000 })
        await new Promise(r => setTimeout(r, 3000))
        await fecharModaisPromocionais(page)
        await page.screenshot({ path: path.join(DEBUG_DIR, 'pendencias.png') })

        const hojeBR = new Date().toLocaleDateString('pt-BR')
        const pendentesHoje = await page.evaluate((hoje) => {
            const linhas = [...document.querySelectorAll('table tbody tr, [class*="row" i]')]
            return linhas
                .map(l => l.textContent.replace(/\s+/g, ' ').trim())
                .filter(texto => texto && texto.includes(hoje))
        }, hojeBR)

        if (pendentesHoje.length === 0) {
            console.log('📋 [Finn] Nenhuma pendência vencendo hoje — nada a notificar')
            return
        }

        const lista = pendentesHoje.map(p => `• ${p}`).join('\n')
        notificarZaya(`📋 *Pendências vencendo hoje (${hojeBR}):*\n\n${lista}`)
        console.log(`📨 [Finn] ${pendentesHoje.length} pendência(s) de hoje notificada(s) à Zaya`)
    } catch (err) {
        console.error('❌ [Finn] Erro ao verificar pendências de hoje:', err.message)
    } finally {
        browserOcupado = false
        if (browser) { try { await browser.close() } catch {} }
    }
}

cron.schedule('0 9 * * *', () => {
    verificarPendenciasHoje()
}, { timezone: 'America/Sao_Paulo' })

// ───────────────────────── Servidor HTTP ─────────────────────────

const FINN_PORT = Number(process.env.FINN_PORT) || 3002

const finnServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/lancar') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', async () => {
            let dados
            try {
                const { texto, imagemBase64, mimeType } = JSON.parse(body)
                if (!texto && !imagemBase64) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    return res.end(JSON.stringify({ ok: false, error: 'Informe "texto" e/ou "imagemBase64"' }))
                }

                console.log(`🧾 [Finn] Lançamento recebido (${imagemBase64 ? 'imagem' : 'texto'}) — extraindo dados...`)
                dados = await extrairLancamento({ imagemBase64, mimeType, texto })
                console.log(`🧾 [Finn] Extraído: ${dados.descricao} — R$ ${dados.valor} (${dados.categoria}/${dados.subcategoria}) — ${dados.status}`)

                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true, status: 'processando', dados }))
            } catch (err) {
                console.error('❌ /lancar (extração) error:', err.message)
                res.writeHead(400, { 'Content-Type': 'application/json' })
                return res.end(JSON.stringify({ ok: false, error: err.message }))
            }

            // Registro no Planner é demorado (Puppeteer) — segue em segundo plano e
            // notifica a Zaya ao concluir, sem segurar a resposta HTTP
            try {
                const { alertaLimite } = await registrarLancamentoNoPlanner(dados)
                const dataFormatada = new Date(`${dados.data}T00:00:00`).toLocaleDateString('pt-BR')
                let mensagem = `✅ *Lançamento registrado!*\n\n📝 ${dados.descricao}\n💰 R$ ${dados.valor.toFixed(2)}\n🏷️ ${dados.categoria} / ${dados.subcategoria}\n📅 ${dataFormatada}\n📌 ${dados.status}`
                if (alertaLimite) mensagem += `\n\n${alertaLimite}`
                notificarZaya(mensagem)
            } catch (err) {
                console.error('❌ [Finn] Erro ao registrar lançamento no Planner:', err.message)
                notificarZaya(`❌ Não consegui registrar o lançamento "${dados.descricao}" no Planner: ${err.message}`)
            }
        })
    } else if (req.method === 'POST' && req.url === '/definir-limite') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
            try {
                const { categoria, valor } = JSON.parse(body)
                const valorNum = Number(valor)
                if (!categoria || !Number.isFinite(valorNum)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' })
                    return res.end(JSON.stringify({ ok: false, error: 'Informe "categoria" e "valor" numérico' }))
                }

                limites[categoria] = valorNum
                salvarJSON(LIMITES_FILE, limites)
                console.log(`💳 [Finn] Limite definido: ${categoria} → R$ ${valorNum.toFixed(2)}`)

                res.writeHead(200, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: true, categoria, valor: valorNum }))
            } catch (err) {
                console.error('❌ /definir-limite error:', err.message)
                res.writeHead(400, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ ok: false, error: err.message }))
            }
        })
    } else if (req.method === 'GET' && req.url === '/abrir-planner') {
        if (browserOcupado) {
            res.writeHead(409, { 'Content-Type': 'application/json' })
            return res.end(JSON.stringify({ ok: false, error: 'Browser ocupado por outra operação — tente novamente em instantes' }))
        }
        browserOcupado = true
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, mensagem: 'Abrindo navegador visível no Planner — confira a tela do computador onde o Finn está rodando' }))

        ;(async () => {
            let browser
            try {
                console.log('🔍 [Finn] Abrindo navegador VISÍVEL para inspeção manual do Planner...')
                browser = await puppeteer.launch({
                    headless: false,
                    executablePath: resolverChrome(),
                    userDataDir: INSPECAO_PROFILE_DIR,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--window-size=1366,768',
                        '--lang=pt-BR',
                    ],
                })
                const page = await browser.newPage()
                await page.setViewport({ width: 1366, height: 768 })
                await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' })

                await fazerLogin(page)
                await page.goto(LANCAMENTOS_URL, { waitUntil: 'networkidle2', timeout: 30000 })
                await new Promise(r => setTimeout(r, 2000))
                await fecharModaisPromocionais(page)

                console.log('🔍 [Finn] Navegador aberto em /controle/lancamentos — inspecione a tela manualmente.')
                console.log('🔍 [Finn] Esse navegador NÃO fecha sozinho — feche a janela manualmente quando terminar a inspeção (o mutex fica ocupado até lá, pausando outras operações do Finn).')

                // Mantém o mutex ocupado enquanto a janela estiver aberta — assim nenhuma
                // outra operação (lançamentos, verificação de pendências) tenta abrir um
                // segundo browser ao mesmo tempo. Checagem ativa de isConnected() em vez
                // de aguardar um evento — só considera fechado quando o usuário realmente
                // fechar a janela manualmente, mantendo o navegador aberto indefinidamente.
                while (browser.isConnected()) {
                    await new Promise(r => setTimeout(r, 2000))
                }
                console.log('🔍 [Finn] Navegador de inspeção fechado — mutex liberado')
            } catch (err) {
                console.error('❌ [Finn] Erro ao abrir navegador de inspeção:', err.message)
            } finally {
                browserOcupado = false
                if (browser && browser.isConnected()) { try { await browser.close() } catch {} }
            }
        })()
    } else if (req.method === 'GET' && req.url === '/limites') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, limites }))
    } else {
        res.writeHead(404)
        res.end()
    }
})

finnServer.listen(FINN_PORT, () => {
    console.log(`🌐 Finn HTTP server escutando na porta ${FINN_PORT}`)
})

console.log('💰 Finn iniciado — agente financeiro')
console.log('⏰ Verificação de pendências de hoje agendada para 9h (Brasília)')
console.log(`📡 Zaya URL: ${process.env.ZAYA_URL || '(não configurada — defina ZAYA_URL no .env)'}`)
if (!process.env.PLANNER_EMAIL || !process.env.PLANNER_PASSWORD) {
    console.warn('⚠️  PLANNER_EMAIL/PLANNER_PASSWORD não definidos no .env — login no Planner falhará')
}
console.log('─────────────────────────────────────────────────')
