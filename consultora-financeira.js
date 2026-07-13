// ─────────────────────────────────────────────────────────────────────────────
// consultora-financeira.js — Consultora financeira pessoal completa da Zaya.
//
// - Groq classifica cada mensagem do dono em DESPESA/RECEITA/CONSULTA_FINANCEIRA/
//   AJUSTE_LIMITE/IGNORAR (1 chamada rápida). COMANDO é resolvido localmente antes
//   disso, sem precisar de IA — mais rápido e mais confiável pra palavras exatas.
// - Para consultas, busca os dados reais do mês (cache de 10 min — mesma leitura já
//   usada no resumo diário) e monta um prompt pra Claude (Haiku) responder com base
//   nesses dados reais + contexto financeiro completo do Maurício.
// - Memória persistente (zaya-memoria.js) guarda parcelas, contas atrasadas, metas
//   (luz/reserva/moto), renda extra por loja, desafios semanais, score histórico.
// - Respostas longas (ex: gasto que estoura categoria) podem vir em várias mensagens
//   separadas por uma linha "---", que o Zaya.js envia uma de cada vez.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config()

const Groq = require('groq-sdk')
const Anthropic = require('@anthropic-ai/sdk')
const plannerAgent = require('./planner-agent')
const memoriaStore = require('./zaya-memoria')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
const anthropic = new Anthropic({ timeout: 20000 }) // ANTHROPIC_API_KEY do .env

const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'
const MAX_TOKENS = 400
const HISTORICO_MAX_MENSAGENS = 10 // ~5 trocas (pergunta+resposta)
const CACHE_TTL_MS = 10 * 60 * 1000 // janela de conversa de 10 min
const STRESS_TTL_MS = 60 * 60 * 1000 // modo economia fica ativo por 1h após o último sinal de estresse

// ───────────────────────── Cache de dados do planner (janela de 10 min) ─────────────────────────

let cacheResumo = null
let cacheTimestamp = 0

// Reaproveita o resumo do mês (mesma leitura do resumo diário) por até 10 min, pra não
// abrir o navegador de novo em toda pergunta de acompanhamento ("e se eu economizar em outro lugar?").
async function obterResumoComCache({ onStatus, forcarAtualizacao = false } = {}) {
    const agora = Date.now()
    if (!forcarAtualizacao && cacheResumo && (agora - cacheTimestamp) < CACHE_TTL_MS) {
        return cacheResumo
    }
    const resumo = await plannerAgent.gerarResumoFinanceiroDiario({ onStatus })
    cacheResumo = resumo
    cacheTimestamp = agora
    return resumo
}

function invalidarCache() {
    cacheResumo = null
    cacheTimestamp = 0
}

function formatarBR(n) {
    return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatarScore(score) {
    return String(score).replace('.', ',')
}

// ───────────────────────── Datas ─────────────────────────

function diasDoMes(data = new Date()) {
    return new Date(data.getFullYear(), data.getMonth() + 1, 0).getDate()
}

function diaAtualDoMes(data = new Date()) {
    return data.getDate()
}

function hojeISO() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}

function mesAtual() {
    return hojeISO().slice(0, 7) // 'AAAA-MM'
}

const NOMES_MES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']

function nomeMes(mesAAAAMM) {
    return NOMES_MES[Number(mesAAAAMM.slice(5, 7)) - 1]
}

function dataParaBRTxt(dataISO) {
    return `${dataISO.slice(8, 10)}/${dataISO.slice(5, 7)}`
}

// ───────────────────────── Modo economia / estresse emocional ─────────────────────────

const PALAVRAS_STRESS = [
    'tô no limite', 'to no limite', 'sem dinheiro', 'sem grana', 'tá apertado', 'ta apertado',
    'apertado', 'modo economia', 'preciso economizar', 'precisa economizar', 'no vermelho',
    'endividado', 'não sei o que fazer', 'nao sei o que fazer', 'desesperado', 'ansioso',
]

let ultimoSinalStress = 0

function detectarEAtualizarStress(texto) {
    const lower = texto.toLowerCase()
    const temSinal = PALAVRAS_STRESS.some(p => lower.includes(p))
    if (temSinal) ultimoSinalStress = Date.now()
    return temSinal
}

function modoEconomiaAtivo() {
    return ultimoSinalStress > 0 && (Date.now() - ultimoSinalStress) < STRESS_TTL_MS
}

// ───────────────────────── Comandos rápidos (locais, sem IA) ─────────────────────────

function nomesItemConhecidos() {
    return Object.keys(plannerAgent.limitesPorItem())
        .concat(['Uber', '99'])
}

// Retorna { tipo: 'saldo'|'dashboard'|'parcelas'|'prioridades'|'termometro'|'desafio'|'categoria'|'pendencias', item? }
// ou null se a mensagem não é um comando rápido reconhecido.
function detectarComandoRapido(texto) {
    const lower = texto.toLowerCase().trim().replace(/[?!.]+$/, '')
    if (['saldo', 'quanto tenho', 'quanto eu tenho'].includes(lower)) return { tipo: 'saldo' }
    if (lower === 'dashboard') return { tipo: 'dashboard' }
    if (['parcelas', 'minhas contas', 'minhas parcelas'].includes(lower)) return { tipo: 'parcelas' }
    if (lower === 'prioridades') return { tipo: 'prioridades' }
    if (['termômetro', 'termometro'].includes(lower)) return { tipo: 'termometro' }
    if (lower === 'desafio') return { tipo: 'desafio' }
    if (['luz quitada', 'quitei a luz', 'paguei a luz toda'].includes(lower)) return { tipo: 'luz_quitada' }
    if (['luz negociada', 'negociei a luz'].includes(lower)) return { tipo: 'luz_negociada' }
    // Frase livre (ex: "o que tenho de pendências", "quais minhas pendências") — não precisa
    // bater exato, "pendênc" já basta pra reconhecer a intenção.
    if (/pend[eê]ncias?/.test(lower)) return { tipo: 'pendencias' }
    const item = nomesItemConhecidos().find(n => n.toLowerCase() === lower)
    if (item) return { tipo: 'categoria', item }
    return null
}

// ───────────────────────── Classificação + extração (Groq) ─────────────────────────

const PROMPT_CLASSIFICACAO = `Classifique a mensagem do dono de uma loja em EXATAMENTE uma destas categorias:

- "DESPESA": relatando um gasto JÁ FEITO/JÁ PAGO, com valor em dinheiro, pra REGISTRAR (ex: "gastei 20 no lanche", "2 reais pão", "paguei a luz, 180").
- "RECEITA": relatando um recebimento JÁ FEITO, com valor, pra REGISTRAR (ex: "recebi 3000 de salário", "recebi 500 da loja 1", "vendi um produto por 80").
- "AJUSTE_LIMITE": pedindo pra MUDAR um limite/orçamento planejado de uma categoria (ex: "muda o limite do mercado pra 600", "aumenta o lanche pra 100", "diminui vestuário pra 20"). Extraia "categoria" (nome exato da categoria/subcategoria) e "novoValor" (número).
- "CONTA_LUZ": relatando uma conta de luz ATRASADA, pendente ou a pagar (ainda NÃO paga). NUNCA use se ele disser que já pagou — isso é "DESPESA" normal. Ex: "a luz de abril tá em 320, venceu dia 10", "ainda devo 200 de luz", "tenho uma conta de luz atrasada de 180". Extraia "valorConta" (número) e "vencimento" (string como foi escrita, ex: "10/04" ou "dia 10" — ou null se não mencionado).
- "CONTA_FUTURA": relatando um gasto/cobrança que AINDA VAI ACONTECER numa data futura específica — ainda não é despesa de hoje, é algo que vai vencer/chegar depois. NUNCA use se for sobre luz (isso é sempre "CONTA_LUZ") nem se o gasto já aconteceu (isso é "DESPESA"). Ex: "5 no cartão de crédito do Thiago em outros, vai vir dia 01/08", "vai chegar uma fatura de internet de 130 dia 10", "vou ter que pagar 200 de aluguel dia 5". Extraia "vencimento" (data como foi escrita, ex: "01/08" ou "dia 10").
- "PARCELA": relatando uma compra PARCELADA, com quantas vezes. Ex: "comprei uma geladeira parcelada em 10x de 150", "parcelei o celular em 6x de 200". Extraia "descricaoParcela" (nome curto do item), "valorParcela" (número, valor de CADA parcela) e "parcelasTotal" (inteiro, número de parcelas).
- "CONSULTA_FINANCEIRA": pergunta ou intenção sobre gastar, comprar, pagar, economizar, situação financeira, ou expressão de estresse financeiro — mesmo sem forma de pergunta e mesmo sem valor definido (ex: "quanto posso gastar hoje?", "quero comprar um sorvete", "vou pegar um uber", "preciso de um tênis novo", "tô no limite", "tá apertado esse mês"). Também use pra perguntas de acompanhamento sobre algo já dito antes (ex: "não está aparecendo como pendente", "foi lançado?").
- "IGNORAR": mensagem sem relação nenhuma com dinheiro, gastos ou orçamento.

REGRA: se a mensagem NÃO menciona um valor em dinheiro, NUNCA é "DESPESA", "RECEITA", "CONTA_LUZ", "CONTA_FUTURA" ou "PARCELA" — é "CONSULTA_FINANCEIRA".

Responda EXCLUSIVAMENTE em JSON:
{"tipo": "DESPESA"|"RECEITA"|"AJUSTE_LIMITE"|"CONTA_LUZ"|"CONTA_FUTURA"|"PARCELA"|"CONSULTA_FINANCEIRA"|"IGNORAR", "categoria": "..." (só AJUSTE_LIMITE), "novoValor": 0.00 (só AJUSTE_LIMITE), "valorConta": 0.00 (só CONTA_LUZ), "vencimento": "..." (CONTA_LUZ ou CONTA_FUTURA), "descricaoParcela": "..." (só PARCELA), "valorParcela": 0.00 (só PARCELA), "parcelasTotal": 0 (só PARCELA)}`

// Retorna { tipo: 'despesa'|'receita'|'ajuste_limite'|'conta_luz'|'parcela'|'consulta'|'ignorar', ...campos extraídos }
// Em caso de erro, assume 'despesa' (mais seguro que arriscar não registrar um gasto real).
async function classificarMensagem(texto) {
    try {
        const resp = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            max_tokens: 150,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: PROMPT_CLASSIFICACAO },
                { role: 'user', content: texto },
            ],
        })
        const bruto = JSON.parse(resp.choices[0].message.content)
        const mapaTipo = {
            DESPESA: 'despesa', RECEITA: 'receita', AJUSTE_LIMITE: 'ajuste_limite',
            CONTA_LUZ: 'conta_luz', CONTA_FUTURA: 'conta_futura', PARCELA: 'parcela',
            CONSULTA_FINANCEIRA: 'consulta', IGNORAR: 'ignorar',
        }
        const tipo = mapaTipo[bruto.tipo] || 'despesa'
        if (tipo === 'ajuste_limite') {
            const novoValor = Number(String(bruto.novoValor).replace(',', '.'))
            if (!bruto.categoria || !Number.isFinite(novoValor) || novoValor <= 0) return { tipo: 'consulta' }
            return { tipo, categoria: bruto.categoria, novoValor }
        }
        if (tipo === 'conta_luz') {
            const valorConta = Number(String(bruto.valorConta).replace(',', '.'))
            if (!Number.isFinite(valorConta) || valorConta <= 0) return { tipo: 'consulta' }
            return { tipo, valorConta, vencimento: bruto.vencimento || null }
        }
        if (tipo === 'conta_futura') {
            if (!bruto.vencimento) return { tipo: 'despesa' } // sem data futura clara, trata como despesa normal
            return { tipo, vencimento: bruto.vencimento }
        }
        if (tipo === 'parcela') {
            const valorParcela = Number(String(bruto.valorParcela).replace(',', '.'))
            const parcelasTotal = Number(bruto.parcelasTotal)
            if (!Number.isFinite(valorParcela) || valorParcela <= 0 || !Number.isFinite(parcelasTotal) || parcelasTotal <= 0) return { tipo: 'consulta' }
            return { tipo, descricaoParcela: bruto.descricaoParcela || 'Compra parcelada', valorParcela, parcelasTotal }
        }
        return { tipo }
    } catch (err) {
        console.log(`⚠️  [Consultora] Falha ao classificar, assumindo despesa: ${err.message}`)
        return { tipo: 'despesa' }
    }
}

// Frases que pedem explicitamente pra registrar algo já mencionado antes na conversa
// (ex: "Luz 103,05 vai vencer 16/07 pendente" seguido de "Anote no planner").
const PALAVRAS_COMANDO_REGISTRAR = [
    'anota', 'anote', 'anote no planner', 'anota no planner', 'lança no planner', 'lanca no planner',
    'lança isso', 'lanca isso', 'registra', 'registre', 'salva isso', 'salve isso', 'cadastra', 'cadastre',
]

function pareceComandoRegistrar(texto) {
    const lower = texto.toLowerCase().trim().replace(/[?!.]+$/, '')
    return PALAVRAS_COMANDO_REGISTRAR.some(p => new RegExp(`(^|\\s)${p}(\\s|$)`).test(lower))
}

// Usa o contexto recente (mensagens anteriores do dono, SEM a própria mensagem "anote...")
// pra descobrir o que ele quer registrar, reaproveitando classificarMensagem sobre o texto
// concatenado. Se vier "despesa"/"receita"/"conta_futura", quem chama ainda precisa extrair
// os campos reais via plannerAgent.interpretarDespesa(contexto) — aqui só decidimos o quê
// registrar.
// Retorna { tipo: 'despesa'|'receita'|'conta_luz'|'conta_futura'|'nenhum', contexto?, valorConta?, vencimento? }
async function processarComandoRegistrar(mensagensRecentes) {
    const contexto = (mensagensRecentes || []).filter(Boolean).join('\n').trim()
    if (!contexto) return { tipo: 'nenhum' }
    const classificacao = await classificarMensagem(contexto)
    if (classificacao.tipo === 'conta_luz') return classificacao
    if (classificacao.tipo === 'conta_futura') return { ...classificacao, contexto }
    if (classificacao.tipo === 'despesa' || classificacao.tipo === 'receita') {
        return { tipo: classificacao.tipo, contexto }
    }
    return { tipo: 'nenhum' }
}

// ───────────────────────── Cálculos financeiros ─────────────────────────

// Formulas pedidas: limite diário, gasto esperado até hoje, saldo de ritmo, quanto dá
// pra gastar hoje sem atrasar o ritmo do mês.
function calcularRitmoItem(limite, realizado) {
    const ultimoDia = diasDoMes()
    const dia = diaAtualDoMes()
    const diasRestantes = ultimoDia - dia + 1
    const limiteDiario = limite / ultimoDia
    const gastoEsperadoAteHoje = limiteDiario * dia
    const saldoRitmo = gastoEsperadoAteHoje - realizado
    const disponivelTotal = limite - realizado
    // "Quanto dá pra gastar hoje" = o que sobrou no mês dividido pelos dias que faltam
    // (incluindo hoje) — divisão simples, sem suavizar por ritmo. Pedido explícito do dono
    // após comparar com a conta manual dele (sobrou R$167,55, faltam 20 dias → R$8,37/dia).
    const podeGastarHoje = Math.max(0, disponivelTotal / diasRestantes)
    return { limiteDiario, gastoEsperadoAteHoje, saldoRitmo, disponivelTotal, podeGastarHoje, diasRestantes }
}

// Score financeiro 0-10. É um heurístico com base no estado ATUAL (o bot é novo, ainda não
// tem 3 meses de histórico pra comparar tendência — isso melhora conforme scoreHistorico cresce).
function calcularScoreFinanceiro(resumo, mem) {
    let pontos = 0
    if (resumo.saldoProjetado > 0) pontos += 3
    else if (resumo.saldoProjetado > -200) pontos += 1

    const limites = plannerAgent.limitesPorItem(mem.limitesOverride)
    const itens = Object.entries(limites)
    const estourados = itens.filter(([item, limite]) => (resumo.porItem[item] || 0) > limite).length
    const percOk = itens.length ? 1 - (estourados / itens.length) : 1
    pontos += percOk * 3

    const temAtrasoPendente = mem.contasAtrasadas.some(c => c.status === 'atrasada')
    pontos += temAtrasoPendente ? 0 : 2

    if (mem.metas.moto.valorAtual > 0 || mem.metas.reservaEmergencia.valorAtual > 0) pontos += 1
    if (mem.metas.reservaEmergencia.valorAtual >= mem.metas.reservaEmergencia.metaMensal) pontos += 1

    return Math.max(0, Math.min(10, Math.round(pontos * 10) / 10))
}

// Meta da moto: progresso, impacto do Uber, projeção de meses pra comprar.
function analisarMoto(mem, resumo) {
    const { valorAtual, valorAlvoMin, valorAlvoMax } = mem.metas.moto
    const faltamMin = Math.max(0, valorAlvoMin - valorAtual)
    const gastoUberMes = resumo.porItem['Uber'] || 0
    const gastoUberProjecaoAno = gastoUberMes * 12
    // "parcela segura máxima = folga mensal futura × 30%" reaproveitado como estimativa de
    // quanto dá pra guardar por mês direcionado à moto.
    const capacidadeGuardarMes = Math.max(0, resumo.saldoProjetado * 0.3)
    const mesesParaComprar = capacidadeGuardarMes > 0 ? Math.ceil(faltamMin / capacidadeGuardarMes) : null
    return { valorAtual, valorAlvoMin, valorAlvoMax, faltamMin, gastoUberMes, gastoUberProjecaoAno, capacidadeGuardarMes, mesesParaComprar }
}

// ───────────────────────── System prompt (contexto financeiro fixo) ─────────────────────────

function montarSystemPrompt(mem, economia) {
    const planejamentoTxt = Object.entries(plannerAgent.limitesPorItem(mem.limitesOverride))
        .map(([item, limite]) => `${item}: R$${formatarBR(limite)}`).join(' | ')

    const contasLuzTxt = mem.contasAtrasadas.length
        ? mem.contasAtrasadas.map(c => `${c.descricao || 'Conta de luz'}: R$${formatarBR((c.valor ?? 0))} (venceu ${c.vencimentoOriginal || '?'}, status: ${c.status})`).join('; ')
        : 'nenhuma conta de luz atrasada registrada ainda — se ele mencionar valores e datas, pergunte os detalhes que faltarem e depois ela é registrada automaticamente'

    return `REGRA ABSOLUTA: MÁXIMO 2 LINHAS POR MENSAGEM. NUNCA ULTRAPASSAR. SE PRECISAR DE MAIS, DIVIDIR EM MENSAGENS SEPARADAS (usando "---" só no caso "gasto CARO" descrito mais abaixo). Essa regra vale ANTES de qualquer outra coisa neste prompt — nenhum contexto, dado ou pendência justifica escrever um parágrafo longo.

Você é a consultora financeira pessoal do Maurício, falando com ele direto pelo WhatsApp através da Zaya. Aja como uma amiga consultora de confiança, nunca como um sistema.

═══ RECEITA ═══
Receita fixa mensal: R$ 3.480,00 (Salário R$3.000 + Vale-Alimentação R$200 + Vale-Transporte R$280 — tratados como valor único, sem controle separado).
O salário entra no 5º dia útil do mês, em Salvador/BA.
Renda extra vem de duas lojas que ele está começando (Loja 1 e Loja 2) — variável, entra no cálculo geral de receita do mês quando lançada. Quando aparecer renda extra, sugira lançar 10% dela como dízimo.

═══ PRIORIDADES, NESSA ORDEM ═══
1. Quitar as contas de luz atrasadas — ${contasLuzTxt}
2. Reserva de emergência — meta: crescer até 10% da receita (R$348/mês). Progresso atual: R$${formatarBR(mem.metas.reservaEmergencia.valorAtual)}.
3. Moto (entre R$8.000 e R$12.000) — progresso atual: R$${formatarBR(mem.metas.moto.valorAtual)}.

═══ PLANEJAMENTO MENSAL (limite por categoria/subcategoria) ═══
${planejamentoTxt}

═══ CLASSIFICAÇÃO DE ESSENCIALIDADE ═══
🔴 ESSENCIAIS (NUNCA sugira cortar): ${plannerAgent.CATEGORIAS_ESSENCIAIS.join(', ')}
🟡 SEMI-ESSENCIAIS (só comprometer se necessário): ${plannerAgent.CATEGORIAS_SEMI_ESSENCIAIS.join(', ')}
🟢 NÃO ESSENCIAIS (podem ser comprometidas primeiro): ${plannerAgent.CATEGORIAS_NAO_ESSENCIAIS.join(', ')}
Uber e 99 não têm planejamento definido — sempre alerte que eles comprometem o orçamento quando aparecerem no gasto.
Eletrodomésticos/Móveis/Etc. e Outros: ignore nos cálculos (pagos pela loja, não são despesa pessoal dele).

═══ PERCENTUAIS IDEAIS (metas progressivas — NUNCA cobrar, só dar dica prática de como chegar lá com o tempo) ═══
Moradia (Aluguel): máx 30% da renda (R$1.044)
Alimentação total (refeições + Mercado): máx 15% (R$522)
Transporte: máx 10% (R$348)
Saúde/higiene: máx 5% (R$174)
Lazer: máx 5% (R$174)
Reserva de emergência: crescer até 10% (R$348/mês)

═══ CÁLCULOS (já vêm prontos nos dados reais abaixo — SEMPRE use os valores exatos dali, NUNCA calcule de cabeça nem invente um número aproximado) ═══
Limite diário = limite mensal ÷ dias do mês. Saldo de ritmo = gasto esperado até hoje − gasto real até hoje (positivo = folga, negativo = atrasado). Folga mensal = receita − gasto total − contas fixas não pagas. Parcela segura máxima = folga mensal futura × 30%.
"Pode gastar hoje" (o que responder quando ele perguntar "quanto posso gastar em X hoje") = disponível no mês da categoria ÷ dias restantes do mês (incluindo hoje) — esse valor já vem PRONTO em cada linha de categoria abaixo ("pode gastar hoje (disponível ÷ dias restantes)"), é só copiar o número de lá.

═══ PERGUNTAS DE "QUANTO TENHO/POSSO GASTAR EM X" ═══
Localize a linha EXATA daquela categoria/subcategoria na lista "Por categoria/subcategoria" dos DADOS REAIS abaixo e responda SÓ com o número daquela linha ("disponível no mês" e/ou "pode gastar hoje", o que ele pediu) — resposta direta, 1 linha, sem contexto extra, sem mencionar pendências, luz atrasada, parcelas ou qualquer outra coisa que ele não pediu. NUNCA use um número de outra categoria, do saldo total do mês ou de qualquer outro cálculo — se não achar a linha exata daquilo que ele perguntou, diga que não achou o dado em vez de estimar ou aproximar.
Exemplo correto: "Maurício, em Mercado dá pra gastar R$8,38 hoje." Exemplo ERRADO (não fazer): emendar "mas você ainda tem a conta de luz atrasada" ou qualquer outra pendência não pedida.

═══ COMO RESPONDER QUANDO ELE PERGUNTAR SOBRE UM GASTO/COMPRA ═══
NÃO mencione contas de luz atrasadas, parcelas ou qualquer outra pendência de propósito — só responda isso se ele perguntar diretamente sobre aquilo. Responda objetivamente se o gasto cabe ou não, sem forçar conexão com outras pendências.
Se BARATO (cabe folgado): diga que cabe, em 1 mensagem de até 2 linhas. Ponto.
Se cabe mas compromete o ritmo: 1 mensagem de até 2 linhas dizendo que cabe + 1 sugestão curta de micro-economia pra moto (só se fizer sentido, sem forçar).
Se CARO (estoura a categoria): no MÁXIMO 3 mensagens curtas (separadas por uma linha só "---"): (1) que passa do disponível, (2) se compensa cortando de não essenciais, (3) parcelamento se couber na folga, ou um "não" claro com alternativa. NUNCA mais que 3 mensagens nesse caso, e cada uma com no máximo 2 linhas.

REGRA CRÍTICA AO SUGERIR CORTE EM OUTRA CATEGORIA: sempre cite o saldo DISPONÍVEL daquela categoria nesse mês (o "disponível no mês" que já vem pronto nos dados reais abaixo) — NUNCA diga que vai mudar, reduzir ou alterar o limite/planejamento dela. Mudar um limite é uma ação diferente que só acontece se ele pedir isso explicitamente.
Frase CORRETA: "Você ainda tem R$ 38,00 em Lavanderia esse mês — dá pra economizar aí."
Frase ERRADA (nunca use algo assim): "vou reduzir seu limite de Lavanderia" ou "posso cortar o orçamento de Lavanderia".

═══ MANTER O FOCO DO ASSUNTO ═══
A checagem obrigatória de pendências (regra acima) vale SÓ pra perguntas sobre gasto/compra ("posso comprar X?", "quero gastar em Y"). Fora desse caso, responda EXATAMENTE sobre o que ele perguntou, sem desviar pra outras pendências não relacionadas.
Se ele perguntar sobre um assunto ESPECÍFICO (ex: "não está aparecendo como pendente no dia 01/08", "foi lançado?", "por que a conta X ainda não venceu?"), responda só sobre AQUILO — nunca puxe pra luz atrasada, outras contas ou qualquer outra pendência que não tem relação direta com a pergunta.

═══ SAUDAÇÕES E MENSAGENS SOCIAIS ═══
Se a mensagem for SÓ uma saudação/social ("oi", "oi Zaya", "tudo bem?", "bom dia", etc.) — SEM pergunta e SEM menção a gasto/dinheiro/compra — responda APENAS com uma saudação curta e humana, 1 linha, sem emendar saldo, contas atrasadas, resumo ou qualquer dado financeiro que ele não pediu. Pendências continuam existindo, mas cumprimento social não é o momento de trazer isso à tona — só entram na resposta quando ele perguntar algo financeiro (ver regra de gasto acima).
Nesse caso específico (só cumprimento), não precisa começar com "Maurício," se soar mais natural sem.
Exemplos corretos: "Maurício, oi! Tudo certo por aqui. 😊" / "Opa! Por aqui tudo bem. 👋"
Errado: responder ao cumprimento com análise de saldo, contas atrasadas ou qualquer dado financeiro sem ele ter pedido.

═══ NUNCA FINGIR QUE ALGO FOI LANÇADO ═══
Você está numa conversa de CONSULTA — não tem nenhum poder de gravar nada no Planner, nem de salvar dado financeiro nenhum. Se você está respondendo, é porque a informação NÃO foi lançada de verdade (quem lança é a automação da Zaya, por fora desta conversa). NUNCA diga "já tá anotado", "anotado aqui", "já registrei", "pode deixar que eu anoto", "anota aí pra pagar quando o salário cair" ou qualquer frase que sugira que algo foi salvo/lançado/registrado — isso é falso e o Maurício vai achar que uma conta está no Planner quando não está. Se ele mencionar uma despesa, receita ou conta futura (com valor) nesta pergunta, não confirme nada — diga que ele precisa mandar o valor e a data/categoria numa mensagem direta pra Zaya lançar de verdade, ex: "Maurício, me manda o valor e quando vence numa mensagem separada que eu já registro certinho no Planner."

═══ TOM E FORMATO — REGRAS RÍGIDAS (NÃO NEGOCIÁVEIS) ═══
- Comece com "Maurício," na grande maioria das respostas (exceção: saudação pura, ver regra acima).
- MÁXIMO 2 LINHAS por mensagem. Isso é um limite físico, não uma sugestão — se a resposta que você escreveria naturalmente tem mais que isso, CORTE, não amplie. A grande maioria das respostas deve ser 1 mensagem só. Isso vale SEMPRE, sem exceção, mesmo em dias de menos tráfego ou quando "daria pra explicar melhor" — resuma, não amplie.
- NUNCA ofereça análise, resumo ou informação financeira que ele não pediu explicitamente. Responda exatamente o que foi perguntado, nem mais nem menos — a única exceção é a checagem obrigatória de pendências ao avaliar um gasto (regra acima), que não é "oferecer informação extra", é parte da própria resposta à pergunta dele.
- Separador "---" (linha sozinha) só é permitido no caso "gasto CARO" acima, e no máximo 3 mensagens. Fora desse caso específico, SEMPRE 1 mensagem só. Não use "---" pra dividir uma explicação longa em pedaços — se está tentado a fazer isso, é sinal de que precisa cortar conteúdo, não dividir.
- Não faça perguntas múltiplas nem ofereça mais de 2 opções numeradas. Uma sugestão direta vale mais que um menu de escolhas.
- Nunca pergunte a categoria de um gasto se ele já informou (ex: "em outros", "no cartão de crédito"). Só pergunte categoria quando ela genuinamente não foi mencionada e não dá pra inferir pelo contexto.
- Formatação do WhatsApp (não é Markdown!): negrito é *um asterisco* de cada lado — NUNCA use **dois asteriscos**. Use negrito raramente, só pra 1 número-chave por mensagem, no máximo.
- Tom humano, direto, como um amigo consultor financeiro — nunca linguagem de extrato bancário, nunca robótica, nunca lista enumerada de opções.
- NÃO use emojis de status (🔴🟢🟡) na resposta — só 1 emoji temático relacionado ao assunto, no final da última mensagem, de forma natural (ex: 🏍️ moto, 🍦 doce, 🚌 transporte, 💡 luz).
- Pense sempre na saúde financeira E emocional dele, mas sem virar terapia — é uma resposta curta de amigo, não uma sessão.
${economia ? '- MODO ECONOMIA ATIVO: seja mais restritiva. Libere essenciais sem ressalva; em semi-essenciais, alerte antes de confirmar; desestimule qualquer gasto não essencial com gentileza mas firmeza — ainda em 1-2 linhas.' : ''}
- Se detectar estresse financeiro (frases como "tô no limite", "sem dinheiro", "tá apertado"), a PRIMEIRA frase acolhe ("Maurício, tá tudo bem.") e o resto da mesma mensagem já traz o dado real que tranquiliza — não vire duas mensagens separadas.
- Celebre conquistas de forma humana e motivadora, em 1 linha, nunca performática.
- Considere o histórico da conversa — se ele já perguntou algo antes, continue o raciocínio sem repetir tudo de novo.`
}

function montarContextoDados(resumo, mem) {
    const ultimoDia = diasDoMes()
    const dia = diaAtualDoMes()
    const diasRestantes = ultimoDia - dia + 1

    const limites = plannerAgent.limitesPorItem(mem.limitesOverride)
    const linhas = Object.entries(limites).map(([item, limite]) => {
        const realizado = resumo.porItem[item] || 0
        const { saldoRitmo, disponivelTotal, podeGastarHoje } = calcularRitmoItem(limite, realizado)
        const ritmoTxt = saldoRitmo >= 0 ? `em dia (R$${formatarBR(saldoRitmo)} de folga)` : `atrasado (R$${formatarBR(Math.abs(saldoRitmo))} acima do esperado)`
        return `- ${item}: gasto R$${formatarBR(realizado)} de R$${formatarBR(limite)} | disponível no mês: R$${formatarBR(disponivelTotal)} | pode gastar hoje (disponível ÷ dias restantes): R$${formatarBR(podeGastarHoje)} | ritmo: ${ritmoTxt}`
    })
    for (const item of ['Uber', '99']) {
        if (resumo.porItem[item] != null) {
            linhas.push(`- ${item}: R$${formatarBR(resumo.porItem[item])} gastos este mês (SEM planejamento — sempre alertar)`)
        }
    }

    const score = calcularScoreFinanceiro(resumo, mem)
    const moto = analisarMoto(mem, resumo)
    const parcelasTxt = mem.parcelas.length
        ? mem.parcelas.map(p => `${p.descricao}: R$${formatarBR(p.valorParcela)}/mês, ${p.parcelasRestantes} parcela(s) restante(s)`).join('; ')
        : 'nenhuma parcela ativa registrada'
    const contasFuturasTxt = (mem.contasFuturas || []).filter(c => c.status !== 'paga').length
        ? mem.contasFuturas.filter(c => c.status !== 'paga')
            .map(c => `${c.descricao} (${c.categoria}${c.subcategoria && c.subcategoria !== c.categoria ? '/' + c.subcategoria : ''}): R$${formatarBR(c.valor)}, vence ${dataParaBRTxt(c.vencimento)}`)
            .join('; ')
        : 'nenhuma conta futura pendente registrada'

    return `DADOS REAIS DE HOJE (dia ${dia} de ${ultimoDia}, faltam ${diasRestantes} dias pro fim do mês):
Total gasto no mês: R$ ${formatarBR(resumo.totalGasto)}
Receita total do mês: R$ ${formatarBR(resumo.receitaTotal)}
Saldo projetado pro fim do mês: R$ ${formatarBR(resumo.saldoProjetado)}
Score financeiro atual: ${formatarScore(score)}/10

Por categoria/subcategoria:
${linhas.join('\n')}

Meta moto: R$${formatarBR(moto.valorAtual)} guardados de R$${formatarBR(moto.valorAlvoMin)} (faltam R$${formatarBR(moto.faltamMin)}). Gasto com Uber este mês: R$${formatarBR(moto.gastoUberMes)} (projeção anual: R$${formatarBR(moto.gastoUberProjecaoAno)}).${moto.mesesParaComprar ? ` No ritmo atual de economia, faltam ~${moto.mesesParaComprar} meses pra comprar a moto.` : ''}

Parcelas ativas: ${parcelasTxt}
Contas de luz atrasadas: ${mem.contasAtrasadas.length ? mem.contasAtrasadas.map(c => `R$${formatarBR((c.valor ?? 0))} (${c.status})`).join(', ') : 'nenhuma registrada ainda'}
Contas futuras pendentes (já lançadas no Planner com a data de vencimento, ainda não pagas): ${contasFuturasTxt}`
}

// ───────────────────────── Histórico curto (em memória) ─────────────────────────

let historico = [] // [{ role: 'user'|'assistant', content: string }]

function adicionarAoHistorico(pergunta, resposta) {
    historico.push({ role: 'user', content: pergunta })
    historico.push({ role: 'assistant', content: resposta })
    if (historico.length > HISTORICO_MAX_MENSAGENS) {
        historico = historico.slice(-HISTORICO_MAX_MENSAGENS)
    }
}

// ───────────────────────── Orquestração principal ─────────────────────────

// Responde uma consulta financeira usando dados reais do mês + memória + histórico curto.
// Retorna um ARRAY de mensagens (normalmente 1, pode ter mais em respostas de gasto caro
// que a Claude decidiu separar com "---"). onStatus(msg) opcional avisa o dono pelo
// WhatsApp durante etapas longas (login manual etc). Nunca lança — qualquer erro vira
// mensagem de erro amigável, sem travar o resto do bot.
async function responderConsultaFinanceira(pergunta, { onStatus } = {}) {
    const mem = memoriaStore.carregarMemoria()
    const economia = detectarEAtualizarStress(pergunta) || modoEconomiaAtivo()

    let resumo
    try {
        resumo = await obterResumoComCache({ onStatus })
    } catch (err) {
        console.error('❌ [Consultora] Não consegui buscar os dados do mês:', err.message)
        return ['❌ Não consegui acessar seus dados financeiros agora (o navegador do Planner pode estar indisponível). Tenta de novo em instantes.']
    }

    const contexto = montarContextoDados(resumo, mem)
    const messages = [
        ...historico,
        { role: 'user', content: `${contexto}\n\nPergunta do Maurício: ${pergunta}` },
    ]

    try {
        console.log('🧠 [Zaya/Claude] Analisando...')
        const resp = await anthropic.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: MAX_TOKENS,
            system: montarSystemPrompt(mem, economia),
            messages,
        })
        const bloco = resp.content.find(b => b.type === 'text')
        const respostaBruta = bloco ? bloco.text.trim() : 'Maurício, não consegui pensar em uma resposta agora — tenta perguntar de outro jeito?'
        adicionarAoHistorico(pergunta, respostaBruta)

        mem.ultimaInteracao = new Date().toISOString()
        memoriaStore.salvarMemoria(mem)

        console.log('🧠 [Zaya/Claude] Resposta enviada')
        return respostaBruta.split(/\n\s*---\s*\n/).map(m => m.trim()).filter(Boolean)
    } catch (err) {
        console.error('❌ [Consultora] Erro na Claude API:', err.message)
        if (err instanceof Anthropic.RateLimitError) {
            return ['Maurício, estou recebendo muitas perguntas agora — tenta de novo em alguns segundos.']
        }
        if (err instanceof Anthropic.APIConnectionError) {
            return ['Maurício, não consegui analisar agora — tenta em instantes.']
        }
        if (err instanceof Anthropic.AuthenticationError) {
            return ['❌ Problema de autenticação com a consultora financeira — avisa o Maurício pra checar a ANTHROPIC_API_KEY.']
        }
        return ['Maurício, não consegui analisar agora — tenta em instantes.']
    }
}

// ───────────────────────── Ajuste de limite (revisão de planejamento) ─────────────────────────

// Aplica um ajuste de limite aprovado pelo Maurício (via classificarMensagem tipo 'ajuste_limite').
// Retorna a mensagem de confirmação (ou erro se a categoria não existir).
function aplicarAjusteLimite(categoria, novoValor) {
    const mem = memoriaStore.carregarMemoria()
    const limitesAtuais = plannerAgent.limitesPorItem(mem.limitesOverride)
    const nomeReal = Object.keys(limitesAtuais).find(n => n.toLowerCase() === categoria.toLowerCase())
        || nomesItemConhecidos().find(n => n.toLowerCase() === categoria.toLowerCase())
    if (!nomeReal) {
        return `Maurício, não achei a categoria "${categoria}" no planejamento — confere o nome? 🤔`
    }
    const valorAntigo = limitesAtuais[nomeReal]
    mem.limitesOverride[nomeReal] = novoValor
    memoriaStore.salvarMemoria(mem)
    invalidarCache() // próxima consulta já usa o novo limite
    return `Maurício, ajustado! *${nomeReal}*: R$${formatarBR((valorAntigo ?? 0))} → R$${formatarBR(novoValor)} por mês. 📝`
}

// ───────────────────────── Luz, parcelamento, renda extra ─────────────────────────

// Converte um vencimento livre ("16/07", "10/04/2026", "dia 10") pra 'AAAA-MM-DD',
// assumindo o ano/mês corrente quando não informado. Retorna null se não conseguir extrair.
function vencimentoParaISO(vencimento) {
    if (!vencimento) return null
    const hoje = hojeISO().split('-') // [AAAA, MM, DD]
    const mData = String(vencimento).match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/)
    if (mData) {
        const [, d, mo, a] = mData
        const diaN = Number(d), mesN = Number(mo)
        if (mesN < 1 || mesN > 12 || diaN < 1 || diaN > 31) return null
        const ano = a ? (a.length === 2 ? 2000 + Number(a) : Number(a)) : Number(hoje[0])
        return `${ano}-${String(mesN).padStart(2, '0')}-${String(diaN).padStart(2, '0')}`
    }
    const mDia = String(vencimento).match(/dia\s*(\d{1,2})\b/i)
    if (mDia) {
        const diaN = Number(mDia[1])
        if (diaN < 1 || diaN > 31) return null
        return `${hoje[0]}-${hoje[1]}-${String(diaN).padStart(2, '0')}`
    }
    return null
}

// Lança a conta de luz no Planner DE VERDADE (categoria Casa/Luz, mesma função de cadastro
// usada pras despesas normais, descrição = nome exato da subcategoria "Luz") e só DEPOIS
// grava em memória — a confirmação ao Maurício só sai se o lançamento real deu certo.
// Memória local é complementar (alimenta prioridades, alertas e os comandos "luz quitada"/
// "luz negociada"), nunca substitui o Planner real.
//
// Conta com vencimento no mês atual entra no limite mensal normalmente (lançada com a data
// real, dentro do mês corrente). Conta com vencimento em mês anterior (já atrasada) é lançada
// com a data ORIGINAL também — como o Balanço Mensal do site é escopado pelo mês real da
// transação, ela automaticamente não conta no gasto do mês atual; só muda a mensagem de
// confirmação, que avisa isso explicitamente em vez de mostrar o % do mês (que não se aplica).
async function registrarContaLuz(valorConta, vencimento, { onStatus } = {}) {
    const dataISO = vencimentoParaISO(vencimento) || hojeISO()
    const atrasada = dataISO.slice(0, 7) < mesAtual()
    let resultado
    try {
        resultado = await plannerAgent.cadastrarDespesa({
            valor: valorConta,
            categoria: 'Casa',
            subcategoria: 'Luz',
            descricao: 'Luz',
            data: dataISO,
            status: 'Pendente', // CONTA_LUZ por definição é uma conta ainda NÃO paga
        }, { onStatus })
    } catch (err) {
        console.error('❌ [Consultora] Erro ao lançar conta de luz no Planner:', err.message)
        return err.message === 'LOGIN_TIMEOUT'
            ? 'Maurício, o login do Planner expirou (5 min) — manda a conta de luz de novo que eu reabro o navegador.'
            : `Maurício, não consegui lançar a conta de luz no Planner agora (${err.message}) — tenta de novo em instantes.`
    }

    const mem = memoriaStore.carregarMemoria()
    mem.contasAtrasadas.push({
        id: `luz_${Date.now()}`,
        descricao: 'Luz',
        valor: valorConta,
        vencimentoOriginal: vencimento,
        status: 'atrasada',
        criadoEm: new Date().toISOString(),
        atualizadoEm: new Date().toISOString(),
    })
    if (mem.metas.luz.status === 'pendente') mem.metas.luz.status = 'em_negociacao'
    memoriaStore.salvarMemoria(mem)
    invalidarCache() // o gasto real do mês mudou

    if (atrasada) {
        return `✅ Despesa registrada!\n\n💡 R$ ${formatarBR(valorConta)} em Luz\n\n⚠️ Conta atrasada — não afeta o limite do mês atual, mas é prioridade pra quitar.`
    }
    return plannerAgent.formatarRespostaWhatsApp(resultado)
}

// Lança uma conta FUTURA (qualquer categoria — cartão, fatura, aluguel, etc. — desde que não
// seja luz, que é sempre CONTA_LUZ) no Planner de verdade, com a DATA INFORMADA e status
// Pendente. `dados` já vem resolvido (valor/categoria/subcategoria/descricao) via
// plannerAgent.interpretarDespesa, chamado por quem invoca esta função. Se o vencimento cai
// num mês diferente do atual, isso naturalmente não conta no Balanço Mensal do mês corrente
// (mesmo princípio de registrarContaLuz) — a mensagem avisa isso; se cai no mês atual, usa o
// formato padrão de despesa (conta normalmente pro limite do mês).
async function registrarContaFutura(dados, vencimento, { onStatus } = {}) {
    const dataISO = vencimentoParaISO(vencimento) || dados.data || hojeISO()
    let resultado
    try {
        resultado = await plannerAgent.cadastrarDespesa({ ...dados, data: dataISO, status: 'Pendente' }, { onStatus })
    } catch (err) {
        console.error('❌ [Consultora] Erro ao lançar conta futura no Planner:', err.message)
        return err.message === 'LOGIN_TIMEOUT'
            ? 'Maurício, o login do Planner expirou (5 min) — manda essa conta de novo que eu reabro o navegador.'
            : `Maurício, não consegui lançar essa conta no Planner agora (${err.message}) — tenta de novo em instantes.`
    }

    const mem = memoriaStore.carregarMemoria()
    mem.contasFuturas.push({
        id: `futura_${Date.now()}`,
        descricao: resultado.nomeItem,
        categoria: dados.categoria,
        subcategoria: dados.subcategoria || null,
        valor: dados.valor,
        vencimento: dataISO,
        status: 'pendente',
        criadoEm: new Date().toISOString(),
    })
    memoriaStore.salvarMemoria(mem)

    const afetaMesAtual = dataISO.slice(0, 7) === mesAtual()
    if (afetaMesAtual) {
        invalidarCache()
        return plannerAgent.formatarRespostaWhatsApp(resultado)
    }
    const emoji = plannerAgent.emojiPara(dados.categoria, dados.subcategoria)
    return `✅ Anotado no Planner!\n\n${emoji} R$ ${formatarBR(dados.valor)} em ${resultado.nomeItem} — vence ${dataParaBRTxt(dataISO)}\n\n⚠️ Não afeta o limite de ${nomeMes(mesAtual())}.`
}

// Registro só em memória — não lança despesa no Planner, porque o valor TOTAL da compra
// não é o gasto mensal real. O que importa pro orçamento é o valor da parcela, que entra
// aqui como um compromisso mensal recorrente pra folga futura/parcela segura. Quando ele
// efetivamente pagar a parcela do mês, isso vira um lançamento normal de despesa (fluxo
// já existente), do jeito que qualquer outra conta é registrada.
function registrarParcela(descricao, valorParcela, parcelasTotal) {
    const mem = memoriaStore.carregarMemoria()
    mem.parcelas.push({
        id: `parcela_${Date.now()}`,
        descricao,
        categoria: null,
        valorParcela,
        parcelasRestantes: parcelasTotal,
        parcelasTotal,
        criadoEm: new Date().toISOString(),
    })
    memoriaStore.salvarMemoria(mem)
    const totalMes = mem.parcelas.reduce((s, p) => s + p.valorParcela, 0)
    return `Maurício, registrei *${descricao}* — R$${formatarBR(valorParcela)}/mês por ${parcelasTotal}x. Total em parcelas agora: R$${formatarBR(totalMes)}/mês. 📝`
}

function registrarRendaExtra(loja, valor) {
    const mem = memoriaStore.carregarMemoria()
    mem.rendaExtra[loja].push({ valor, data: hojeISO() })
    memoriaStore.salvarMemoria(mem)
    const nome = { loja1: 'Loja 1', loja2: 'Loja 2', outros: 'outra fonte' }[loja]
    return `Maurício, anotei R$${formatarBR(valor)} de renda extra da ${nome}. 💰`
}

// ───────────────────────── Desafio semanal ─────────────────────────

function segundaFeiraDaSemana(data = new Date()) {
    const d = new Date(data)
    const diaSemana = d.getDay() // 0 = domingo
    const diff = diaSemana === 0 ? -6 : 1 - diaSemana
    d.setDate(d.getDate() + diff)
    return d.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
}

// Retorna o desafio ativo da semana atual, gerando um novo se ainda não existir.
// Escolhe a categoria NÃO ESSENCIAL com maior gasto no mês (mais espaço real pra cortar).
function gerarDesafioSemanal(mem, resumo) {
    const segunda = segundaFeiraDaSemana()
    const existente = mem.desafiosSemanais.find(d => d.segunda === segunda && d.status === 'ativo')
    if (existente) return existente

    const candidatos = plannerAgent.CATEGORIAS_NAO_ESSENCIAIS
        .map(item => ({ item, gasto: resumo.porItem[item] || 0 }))
        .filter(c => c.gasto > 0)
        .sort((a, b) => b.gasto - a.gasto)

    const alvo = candidatos[0] || { item: 'Lazer', gasto: 0 }
    const dia = diaAtualDoMes()
    const economiaEstimada = alvo.gasto > 0 ? Math.round((alvo.gasto / Math.max(1, dia)) * 7 * 100) / 100 : 20

    const desafio = {
        id: `desafio_${Date.now()}`,
        segunda,
        descricao: `Desafio da semana: zero ${alvo.item} — economia estimada de R$${formatarBR(economiaEstimada)} direto pra moto`,
        categoriaAlvo: alvo.item,
        economiaEstimada,
        status: 'ativo',
    }
    mem.desafiosSemanais.push(desafio)
    memoriaStore.salvarMemoria(mem)
    return desafio
}

// ───────────────────────── Comandos rápidos (formatação) ─────────────────────────

function formatarSaldo(resumo) {
    return `Maurício, seu saldo disponível esse mês é *R$${formatarBR(resumo.saldoProjetado)}* (de R$${formatarBR(resumo.receitaTotal)} de receita).`
}

function formatarDashboard(resumo, mem) {
    const score = calcularScoreFinanceiro(resumo, mem)
    const limites = plannerAgent.limitesPorItem(mem.limitesOverride)
    const criticas = Object.entries(limites)
        .map(([item, limite]) => ({ item, limite, realizado: resumo.porItem[item] || 0 }))
        .filter(c => c.realizado > c.limite)
        .map(c => `${c.item} (R$${formatarBR((c.realizado - c.limite))} acima)`)
    const moto = analisarMoto(mem, resumo)
    const prioridadeAtual = mem.metas.luz.status !== 'quitado'
        ? 'quitar as contas de luz'
        : (mem.metas.reservaEmergencia.valorAtual < mem.metas.reservaEmergencia.metaMensal ? 'reserva de emergência' : 'moto')

    return [
        '📊 *Dashboard financeiro*',
        '',
        `Gasto no mês: R$${formatarBR(resumo.totalGasto)} de R$${formatarBR(resumo.receitaTotal)}`,
        `Projeção: sobram R$${formatarBR(resumo.saldoProjetado)}`,
        `Score: ${formatarScore(score)}/10`,
        '',
        criticas.length ? `⚠️ Categorias estouradas: ${criticas.join(', ')}` : '✅ Nenhuma categoria estourada',
        `Parcelas ativas: ${mem.parcelas.length}`,
        `Prioridade atual: ${prioridadeAtual}`,
        `🏍️ Moto: R$${formatarBR(moto.valorAtual)} de R$${formatarBR(moto.valorAlvoMin)}`,
    ].join('\n')
}

function formatarParcelas(mem) {
    if (!mem.parcelas.length) return 'Maurício, você não tem nenhuma parcela ativa registrada agora. 👍'
    const linhas = mem.parcelas.map(p => `• ${p.descricao}: R$${formatarBR(p.valorParcela)}/mês — ${p.parcelasRestantes} de ${p.parcelasTotal} restante(s)`)
    const totalMes = mem.parcelas.reduce((s, p) => s + p.valorParcela, 0)
    return `Maurício, suas parcelas ativas:\n\n${linhas.join('\n')}\n\nTotal comprometido por mês: R$${formatarBR(totalMes)}`
}

function formatarPrioridades(mem) {
    const contasAbertas = mem.contasAtrasadas.filter(c => c.status !== 'quitada')
    const luzTxt = mem.metas.luz.status === 'quitado'
        ? 'quitado! 🎉'
        : (contasAbertas.length ? `R$${formatarBR(contasAbertas.reduce((s, c) => s + (c.valor || 0), 0))} restante` : 'sem valores registrados ainda')
    return `1️⃣ Luz: ${luzTxt}\n2️⃣ Emergência: R$${formatarBR(mem.metas.reservaEmergencia.valorAtual)} de R$${formatarBR(mem.metas.reservaEmergencia.metaMensal)}\n3️⃣ Moto: R$${formatarBR(mem.metas.moto.valorAtual)} de R$${formatarBR(mem.metas.moto.valorAlvoMin)}`
}

function formatarTermometro(resumo, mem) {
    const score = calcularScoreFinanceiro(resumo, mem)
    let msg
    if (score >= 8) msg = 'Você tá mandando muito bem!'
    else if (score >= 6) msg = 'Tá indo bem, com espaço pra melhorar.'
    else if (score >= 4) msg = 'Dá pra melhorar — bora ajustar o ritmo.'
    else msg = 'Precisa de atenção nos próximos dias.'
    return `Maurício, seu termômetro financeiro tá em *${formatarScore(score)}/10*. ${msg} 🌡️`
}

function formatarCategoria(item, resumo, mem) {
    const limites = plannerAgent.limitesPorItem(mem.limitesOverride)
    const limite = limites[item]
    const realizado = resumo.porItem[item] || 0
    if (limite == null) {
        return `Maurício, ${item} não tem limite definido — já foi R$${formatarBR(realizado)} este mês (fica de olho, é sem planejamento). ⚠️`
    }
    const { disponivelTotal, podeGastarHoje } = calcularRitmoItem(limite, realizado)
    if (disponivelTotal < 0) {
        return `Maurício, *${item}* já estourou — você usou R$${formatarBR(realizado)} de R$${formatarBR(limite)} (R$${formatarBR(Math.abs(disponivelTotal))} acima do planejado). Melhor segurar por aqui esse mês. ⚠️`
    }
    return `Maurício, em *${item}* você já usou R$${formatarBR(realizado)} de R$${formatarBR(limite)}. Sobram R$${formatarBR(disponivelTotal)} no mês — hoje dá pra gastar até R$${formatarBR(podeGastarHoje)}.`
}

function formatarDesafio(mem, resumo) {
    const desafio = gerarDesafioSemanal(mem, resumo)
    return `🎯 ${desafio.descricao} 🏍️`
}

// ───────────────────────── Resumo diário (8h) ─────────────────────────

// resumo.dica já vem pronta de plannerAgent.gerarResumoFinanceiroDiario() — a mesma
// lógica de "economiza em não-essencial com folga / alerta se ritmo ruim / elogia se
// tá indo bem" já cobre o pedido de "dica baseada nos dados reais".
function formatarResumoDiarioCompleto(resumo, mem) {
    const moto = analisarMoto(mem, resumo)
    return `Maurício, bom dia! ☀️

Este mês você já gastou *R$${formatarBR(resumo.totalGasto)}* de *R$${formatarBR(resumo.receitaTotal)}*.
Projeção: sobram *R$${formatarBR(resumo.saldoProjetado)}* no fim do mês.
🏍️ Moto: R$${formatarBR(moto.valorAtual)} guardados de R$${formatarBR(moto.valorAlvoMin)}.

${resumo.dica}`
}

// Lê /controle/pendencias de verdade (plannerAgent.listarPendenciasAteHoje) e devolve UMA
// mensagem POR pendência atrasada até hoje — pedido explícito do dono, nada de lista única.
async function formatarPendencias({ onStatus } = {}) {
    let pendencias
    try {
        pendencias = await plannerAgent.listarPendenciasAteHoje({ onStatus })
    } catch (err) {
        console.error('❌ [Consultora] Erro ao ler pendências:', err.message)
        return [err.message === 'LOGIN_TIMEOUT'
            ? 'Maurício, o login do Planner expirou (5 min) — pede de novo que eu reabro o navegador.'
            : `Maurício, não consegui checar as pendências agora (${err.message}) — tenta de novo em instantes.`]
    }
    if (!pendencias.length) {
        return ['Maurício, nenhuma pendência atrasada até hoje. ✅']
    }
    // Mesmo padrão visual das confirmações de lançamento (✅ Anotado no Planner! / ✅ Despesa
    // registrada!), sem linha de prioridade — só o essencial: item, valor, vencimento.
    return pendencias.map(p => {
        const emoji = plannerAgent.emojiPara(p.nomeItem, p.nomeItem)
        const valorTxt = p.valor != null ? formatarBR(p.valor) : '?'
        return `⚠️ Conta pendente!\n\n${emoji} R$ ${valorTxt} em ${p.nomeItem} — venceu ${p.dataCurta}`
    })
}

// Dispatcher dos comandos rápidos — retorna um ARRAY de mensagens (mesmo contrato de
// responderConsultaFinanceira), ou null se o tipo de comando não for reconhecido.
async function processarComandoRapido(comando, { onStatus } = {}) {
    // luz_quitada/luz_negociada são operações só de memória — não precisam dos dados
    // do mês, resolvidas antes de abrir o navegador. pendencias abre o navegador só pra
    // essa página específica, não precisa do resumo mensal (obterResumoComCache).
    if (comando.tipo === 'luz_quitada') {
        const mem = memoriaStore.carregarMemoria()
        mem.contasAtrasadas.forEach(c => { if (c.status !== 'quitada') { c.status = 'quitada'; c.atualizadoEm = new Date().toISOString() } })
        mem.metas.luz.status = 'quitado'
        memoriaStore.salvarMemoria(mem)
        return ['Maurício, luz quitada! 🎉 Bora focar na reserva de emergência agora.']
    }
    if (comando.tipo === 'luz_negociada') {
        const mem = memoriaStore.carregarMemoria()
        mem.contasAtrasadas.forEach(c => { if (c.status === 'atrasada') c.status = 'negociada' })
        mem.metas.luz.status = 'em_negociacao'
        memoriaStore.salvarMemoria(mem)
        return ['Maurício, marquei a luz como negociada. Quando quitar, me diga "luz quitada". 📝']
    }
    if (comando.tipo === 'pendencias') {
        return await formatarPendencias({ onStatus })
    }

    const mem = memoriaStore.carregarMemoria()
    let resumo
    try {
        resumo = await obterResumoComCache({ onStatus })
    } catch (err) {
        console.error('❌ [Consultora] Não consegui buscar dados pro comando:', err.message)
        return ['❌ Não consegui acessar seus dados financeiros agora. Tenta de novo em instantes.']
    }
    switch (comando.tipo) {
        case 'saldo': return [formatarSaldo(resumo)]
        case 'dashboard': return [formatarDashboard(resumo, mem)]
        case 'parcelas': return [formatarParcelas(mem)]
        case 'prioridades': return [formatarPrioridades(mem)]
        case 'termometro': return [formatarTermometro(resumo, mem)]
        case 'desafio': return [formatarDesafio(mem, resumo)]
        case 'categoria': return [formatarCategoria(comando.item, resumo, mem)]
        default: return null
    }
}

// ───────────────────────── Calendário mensal (dia 1) ─────────────────────────

function quintoDiaUtil(ano, mesIndex) {
    let dia = new Date(ano, mesIndex, 1)
    let uteis = 0
    while (true) {
        const diaSemana = dia.getDay()
        if (diaSemana !== 0 && diaSemana !== 6) {
            uteis++
            if (uteis === 5) return dia.getDate()
        }
        dia.setDate(dia.getDate() + 1)
    }
}

// Não considera feriados (sem calendário de feriados disponível) — é uma aproximação
// só por dias úteis (sem contar sábado/domingo).
function gerarCalendarioMensal(mem) {
    const agora = new Date()
    const diaSalario = quintoDiaUtil(agora.getFullYear(), agora.getMonth())

    const vencimentos = []
    const lucAbertas = mem.contasAtrasadas.filter(c => c.status !== 'quitada')
    if (lucAbertas.length) {
        vencimentos.push(`Luz atrasada: R$${formatarBR(lucAbertas.reduce((s, c) => s + (c.valor || 0), 0))} (ver "prioridades")`)
    }
    vencimentos.push('Aluguel/Internet/Água/Gás: datas exatas ainda não registradas — me diga os dias de vencimento que eu guardo aqui')
    for (const p of mem.parcelas) {
        vencimentos.push(`${p.descricao}: R$${formatarBR(p.valorParcela)}/mês`)
    }

    return `Maurício, calendário do mês: 📅
💰 Salário: dia ${diaSalario}
📋 Vencimentos: ${vencimentos.join(' | ')}
🎯 Metas: luz (${mem.metas.luz.status}) | reserva R$${formatarBR(mem.metas.reservaEmergencia.valorAtual)} de R$${formatarBR(mem.metas.reservaEmergencia.metaMensal)} | moto R$${formatarBR(mem.metas.moto.valorAtual)} de R$${formatarBR(mem.metas.moto.valorAlvoMin)}`
}

// ───────────────────────── Relatório mensal (último dia do mês) ─────────────────────────

function nomeMesPtBR(data = new Date()) {
    const nome = data.toLocaleDateString('pt-BR', { month: 'long', timeZone: 'America/Sao_Paulo' })
    return nome.charAt(0).toUpperCase() + nome.slice(1)
}

// Também grava o gasto por categoria do mês em mem.historicoGastosPorCategoria, alimentando
// a análise de padrões (item #3 da memória) mês a mês.
async function gerarRelatorioMensal(mem) {
    const resumo = await obterResumoComCache({ forcarAtualizacao: true })
    const limites = plannerAgent.limitesPorItem(mem.limitesOverride)
    const totalPlanejado = Object.values(limites).reduce((s, v) => s + v, 0)
    const economizado = totalPlanejado - resumo.totalGasto

    const itens = Object.entries(limites).map(([item, limite]) => ({
        item, folga: limite - (resumo.porItem[item] || 0),
    }))
    const melhor = itens.slice().sort((a, b) => b.folga - a.folga)[0]
    const pior = itens.slice().sort((a, b) => a.folga - b.folga)[0]
    const moto = analisarMoto(mem, resumo)

    let recomendacao
    if (resumo.saldoProjetado < 0) recomendacao = 'Mês apertado — no próximo, priorize cortar em não essenciais logo no início.'
    else if (pior && pior.folga < 0) recomendacao = `Fica de olho em ${pior.item} no próximo mês — foi o que mais estourou.`
    else recomendacao = 'Mês equilibrado — seguir nesse ritmo já ajuda bastante nas metas.'

    mem.historicoGastosPorCategoria[mesAtual()] = { ...resumo.porItem }

    // Fechou o mês: decrementa 1 parcela de cada compromisso ativo, removendo os quitados.
    mem.parcelas = mem.parcelas
        .map(p => ({ ...p, parcelasRestantes: p.parcelasRestantes - 1 }))
        .filter(p => p.parcelasRestantes > 0)

    memoriaStore.salvarMemoria(mem)

    return `Maurício, fechamento de ${nomeMesPtBR()}:
Planejado: R$${formatarBR(totalPlanejado)} | Gasto: R$${formatarBR(resumo.totalGasto)} | Economizado: R$${formatarBR(economizado)}
Melhor categoria: ${melhor ? melhor.item : '-'} | Mais estourou: ${pior && pior.folga < 0 ? pior.item : 'nenhuma 🎉'}
Moto: R$${formatarBR(moto.valorAtual)} guardados no total 🏍️
${recomendacao}`
}

// ───────────────────────── Revisão de planejamento (dia 1) ─────────────────────────

function ofertarRevisaoPlanejamento() {
    return 'Maurício, começou o mês! Quer revisar o planejamento com base no mês passado? Me diga "sim" que eu trago sugestões, ou pode ignorar que seguimos com o mesmo. 📋'
}

// ───────────────────────── Alertas proativos ─────────────────────────

function jaAlertado(mem, chave) {
    return mem.alertasEnviados[chave] != null
}

function marcarAlertado(mem, chave) {
    mem.alertasEnviados[chave] = new Date().toISOString()
}

// Interpreta uma data BR livre ("10/05", "10/05/2026") — usada só pra contas com
// vencimento futuro registrado. Sem ano, assume o ano corrente (ou o próximo, se a data
// já passou nesse ano — evita marcar como "vencida há meses" uma data recorrente mensal).
function parseDataBrLivre(str) {
    if (!str) return null
    const m = String(str).match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/)
    if (!m) return null
    const [, d, mo, a] = m
    const hoje = new Date()
    const ano = a ? (a.length === 2 ? 2000 + Number(a) : Number(a)) : hoje.getFullYear()
    const data = new Date(ano, Number(mo) - 1, Number(d))
    if (isNaN(data)) return null
    if (!a && data < hoje) data.setFullYear(ano + 1)
    return data
}

// Verifica os 6 tipos de alerta implementados (o 7º — assinatura recorrente não
// identificada — foi adiado de propósito: precisa de histórico por transação em 2+
// meses, e hoje só existe agregado por categoria/mês (mem.historicoGastosPorCategoria,
// alimentado 1x/mês pelo relatório mensal). Reavaliar quando essa base existir.
// Retorna um array de mensagens (pode ser vazio). Dedup via mem.alertasEnviados —
// cada alerta só é enviado uma vez (chaves com o mês/data embutidos se repetem
// naturalmente no próximo mês/dia; chaves por id nunca repetem).
async function verificarAlertasProativos({ onStatus } = {}) {
    const mem = memoriaStore.carregarMemoria()
    let resumo
    try {
        resumo = await obterResumoComCache({ onStatus })
    } catch (err) {
        console.error('❌ [Consultora/Alertas] Não consegui buscar os dados do mês:', err.message)
        return []
    }

    const alertas = []
    const limites = plannerAgent.limitesPorItem(mem.limitesOverride)
    const mes = mesAtual()
    const dia = diaAtualDoMes()

    // 1) conta vencendo em ≤3 dias — só dispara pra contas com vencimento futuro parseável
    // (hoje só luz atrasada tem alguma data registrada, geralmente no passado).
    for (const c of mem.contasAtrasadas.filter(c => c.status !== 'quitada')) {
        const data = parseDataBrLivre(c.vencimentoOriginal)
        if (!data) continue
        const diasFaltando = Math.ceil((data - new Date()) / 86400000)
        const chave = `contaVencendo_${c.id}`
        if (diasFaltando >= 0 && diasFaltando <= 3 && !jaAlertado(mem, chave)) {
            alertas.push(`Maurício, a conta "${c.descricao || 'conta'}" (R$${formatarBR(c.valor || 0)}) vence em ${diasFaltando === 0 ? 'hoje' : diasFaltando + ' dia(s)'}. 📅`)
            marcarAlertado(mem, chave)
        }
    }

    // 1b) conta futura vencendo em ≤3 dias — vencimento já vem como AAAA-MM-DD (registrado
    // via registrarContaFutura), não precisa de parseDataBrLivre.
    for (const cf of (mem.contasFuturas || []).filter(c => c.status !== 'paga')) {
        const data = new Date(`${cf.vencimento}T00:00:00`)
        if (isNaN(data)) continue
        const diasFaltando = Math.ceil((data - new Date()) / 86400000)
        const chave = `contaFutura_${cf.id}`
        if (diasFaltando >= 0 && diasFaltando <= 3 && !jaAlertado(mem, chave)) {
            alertas.push(`Maurício, a conta "${cf.descricao || 'conta'}" (R$${formatarBR(cf.valor || 0)}) vence em ${diasFaltando === 0 ? 'hoje' : diasFaltando + ' dia(s)'}. 📅`)
            marcarAlertado(mem, chave)
        }
    }

    // 2) categoria zerada (já bateu ou passou do limite)
    for (const [item, limite] of Object.entries(limites)) {
        const realizado = resumo.porItem[item] || 0
        const chave = `categoriaEstourada_${mes}_${item}`
        if (realizado >= limite && !jaAlertado(mem, chave)) {
            alertas.push(`Maurício, *${item}* zerou o limite do mês (R$${formatarBR(realizado)} de R$${formatarBR(limite)}). ⚠️`)
            marcarAlertado(mem, chave)
        }
    }

    // 3) gasto alto num único dia (>10% do orçamento mensal total)
    const orcamentoTotal = Object.values(limites).reduce((s, v) => s + v, 0)
    const limiarDia = orcamentoTotal * 0.10
    for (const [data, valor] of Object.entries(resumo.porDia || {})) {
        const chave = `gastoAltoDia_${data}`
        if (valor > limiarDia && !jaAlertado(mem, chave)) {
            alertas.push(`Maurício, dia ${data} teve gasto de R$${formatarBR(valor)} — mais de 10% do orçamento mensal num dia só. 👀`)
            marcarAlertado(mem, chave)
        }
    }

    // 4) categoria a caminho de estourar em menos de 5 dias, no ritmo atual
    for (const [item, limite] of Object.entries(limites)) {
        const realizado = resumo.porItem[item] || 0
        if (realizado >= limite) continue // já coberto pelo #2
        const ritmoDiario = realizado / Math.max(1, dia)
        if (ritmoDiario <= 0) continue
        const diasParaEstourar = (limite - realizado) / ritmoDiario
        const chave = `categoriaEstourandoEm5_${mes}_${item}`
        if (diasParaEstourar < 5 && !jaAlertado(mem, chave)) {
            alertas.push(`Maurício, no ritmo atual *${item}* deve estourar em ~${Math.max(1, Math.round(diasParaEstourar))} dia(s). 📉`)
            marcarAlertado(mem, chave)
        }
    }

    // 5) possível gasto duplicado (mesmo item + mesmo valor + mesma data, 2x ou mais)
    const porAssinatura = {}
    for (const t of resumo.transacoes || []) {
        const chaveT = `${t.data}|${t.item}|${t.valor.toFixed(2)}`
        porAssinatura[chaveT] = (porAssinatura[chaveT] || 0) + 1
    }
    for (const [chaveT, count] of Object.entries(porAssinatura)) {
        if (count < 2) continue
        const chave = `dupe_${chaveT}`
        if (!jaAlertado(mem, chave)) {
            const [data, item, valor] = chaveT.split('|')
            alertas.push(`Maurício, reparei ${count}x um gasto igual de R$${valor.replace('.', ',')} em *${item}* no dia ${data} — duplicado ou é normal mesmo? 🤔`)
            marcarAlertado(mem, chave)
        }
    }

    // 6) padrão de endividamento (parcelamento acumulando)
    const totalParcelasMes = mem.parcelas.reduce((s, p) => s + p.valorParcela, 0)
    const chaveEndiv = `endividamento_${mes}`
    if ((mem.parcelas.length >= 3 || totalParcelasMes > plannerAgent.RECEITA_BASE_MENSAL * 0.15) && !jaAlertado(mem, chaveEndiv)) {
        alertas.push(`Maurício, suas parcelas somam R$${formatarBR(totalParcelasMes)}/mês — segura antes de parcelar mais alguma coisa esse mês. 💳`)
        marcarAlertado(mem, chaveEndiv)
    }

    if (alertas.length) memoriaStore.salvarMemoria(mem)
    return alertas
}

module.exports = {
    classificarMensagem,
    pareceComandoRegistrar,
    processarComandoRegistrar,
    detectarComandoRapido,
    processarComandoRapido,
    responderConsultaFinanceira,
    aplicarAjusteLimite,
    registrarContaLuz,
    registrarContaFutura,
    registrarParcela,
    registrarRendaExtra,
    obterResumoComCache,
    invalidarCache,
    calcularRitmoItem,
    calcularScoreFinanceiro,
    analisarMoto,
    gerarDesafioSemanal,
    segundaFeiraDaSemana,
    formatarResumoDiarioCompleto,
    gerarCalendarioMensal,
    gerarRelatorioMensal,
    ofertarRevisaoPlanejamento,
    verificarAlertasProativos,
    modoEconomiaAtivo,
    diasDoMes,
    diaAtualDoMes,
    mesAtual,
    hojeISO,
    CLAUDE_MODEL,
}
