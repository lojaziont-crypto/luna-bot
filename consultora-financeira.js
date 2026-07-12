// ─────────────────────────────────────────────────────────────────────────────
// consultora-financeira.js — Consultora financeira inteligente da Zaya.
//
// - Groq classifica se a mensagem do dono é uma CONSULTA (pergunta sobre o
//   orçamento) ou um LANÇAMENTO (despesa/receita a registrar) — 1 chamada rápida.
// - Para consultas, busca os dados reais do mês (reaproveita planner-agent.js,
//   mesma leitura já usada no resumo diário) e monta um prompt pra Claude API
//   responder com base nesses dados reais.
// - Histórico curto (últimas trocas) mantido em memória pra perguntas de
//   acompanhamento tipo "e pra lanche?".
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config()

const Groq = require('groq-sdk')
const Anthropic = require('@anthropic-ai/sdk')
const plannerAgent = require('./planner-agent')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
const anthropic = new Anthropic({ timeout: 20000 }) // ANTHROPIC_API_KEY do .env

const CLAUDE_MODEL = 'claude-opus-4-8'
const HISTORICO_MAX_MENSAGENS = 10 // ~5 trocas (pergunta+resposta)

// ───────────────────────── Classificação: consulta vs lançamento ─────────────────────────

const PROMPT_CLASSIFICACAO = `Classifique a mensagem do dono de uma loja como:
- "despesa": ele está relatando um gasto ou recebimento para REGISTRAR (ex: "gastei 20 no lanche", "2 reais pão", "recebi 3000 de salário").
- "consulta": ele está PERGUNTANDO sobre a situação financeira dele, sem mencionar um novo gasto a registrar (ex: "quanto posso gastar hoje?", "quanto sobrou pra Uber esse mês?", "tô gastando muito em quê?", "posso pedir um ifood hoje?", "como tá meu orçamento?").

Responda EXCLUSIVAMENTE em JSON: {"tipo": "despesa"} ou {"tipo": "consulta"}`

// Retorna 'despesa' ou 'consulta'. Em caso de erro na classificação, assume 'despesa'
// (mantém o comportamento anterior — mais seguro que arriscar não registrar um gasto real).
async function classificarMensagem(texto) {
    try {
        const resp = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            max_tokens: 20,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: PROMPT_CLASSIFICACAO },
                { role: 'user', content: texto },
            ],
        })
        const bruto = JSON.parse(resp.choices[0].message.content)
        return bruto.tipo === 'consulta' ? 'consulta' : 'despesa'
    } catch (err) {
        console.log(`⚠️  [Consultora] Falha ao classificar, assumindo despesa: ${err.message}`)
        return 'despesa'
    }
}

// Pré-filtro leve: mensagem tem cara de pergunta financeira (independente de conter
// valor monetário, diferente de pareceDespesa). Roda ANTES da classificação Groq pra
// evitar chamar o Groq em toda mensagem qualquer.
const PALAVRAS_PERGUNTA = ['quanto', 'posso', 'consigo', 'tá', 'ta ', 'como', 'sobrou', 'sobra', 'gastando', 'estourei', 'estourando']
const PALAVRAS_DINHEIRO = ['gast', 'orçamento', 'orcamento', 'limite', 'disponív', 'disponiv', 'dinheiro', 'budget', 'saldo']

function pareceConsultaFinanceira(texto) {
    const lower = texto.toLowerCase()
    const temPergunta = PALAVRAS_PERGUNTA.some(p => lower.includes(p)) || lower.includes('?')
    if (!temPergunta) return false
    const nomesItem = [
        ...plannerAgent.CATEGORIAS_DESPESA,
        ...Object.values(plannerAgent.PLANEJAMENTO).flatMap(v => Object.keys(v.subs)),
        ...plannerAgent.RECEITAS,
        ...Object.values(plannerAgent.PALAVRAS_INFORMAIS).flat(),
    ]
    return PALAVRAS_DINHEIRO.some(p => lower.includes(p)) || nomesItem.some(n => n.length > 2 && lower.includes(n.toLowerCase()))
}

// ───────────────────────── Contexto financeiro fixo (system prompt) ─────────────────────────

const SYSTEM_PROMPT_BASE = `Você é uma consultora financeira pessoal do Maurício. Aqui estão as regras financeiras dele:

Receita fixa mensal: R$ 3.480,00 (Salário R$3.000 + Vale-Alimentação R$200 + Vale-Transporte R$280)
Quando houver Renda Extra lançada no mês, somar à receita base.

Planejamento mensal:
Academia: R$139,90 | Lanche: R$90 | Almoço: R$60 | Café da Manhã: R$40 | Jantar: R$30 | Ração: R$100 | Aluguel: R$1.450 | Internet: R$130 | Água: R$70 | Luz: R$70 | Gás: R$20 | Corte de Cabelo: R$60 | Produtos: R$30 | Emergência: R$100 | Lavanderia: R$66 | Viagem/Lazer: R$50 | Mercado: R$500 | Metrô: R$205 | Ônibus: R$90 | Vestuário: R$30

Classificação:
🔴 ESSENCIAIS (não sugerir corte): Aluguel, Água, Luz, Gás, Internet, Mercado, Metrô, Ônibus, Academia, Animal de Estimação/Ração
🟡 SEMI-ESSENCIAIS (sugerir corte só se necessário): Almoço, Lanche, Café da Manhã, Jantar, Farmácia, Cuidados Pessoais, Lavanderia
🟢 NÃO ESSENCIAIS (prioridade na dica de economia): Lazer/Viagem, Vestuário, Uber, 99

Uber e 99 não têm planejamento definido — sempre alertar que comprometem o orçamento.
Eletrodomésticos e Outros: ignorar nos cálculos (pagos pela loja).
Meta: tentar guardar o máximo possível no fim do mês — calcular dinamicamente o que é possível economizar.

Orçamento diário proporcional: limite mensal de cada categoria ÷ dias do mês = quanto pode gastar por dia naquela categoria.

Responda sempre em português, de forma amigável, direta e pessoal. Nunca use linguagem de extrato bancário. Máximo 5-6 linhas por resposta. Considere sempre o contexto da conversa anterior.`

// ───────────────────────── Dados reais do mês (via planner-agent.js) ─────────────────────────

function montarContextoDados(resumo) {
    const hoje = new Date()
    const ultimoDiaMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate()
    const diaAtual = hoje.getDate()
    const diasRestantes = ultimoDiaMes - diaAtual + 1

    const limites = plannerAgent.limitesPorItem()
    const linhas = Object.entries(limites).map(([item, limite]) => {
        const realizado = resumo.porItem[item] || 0
        const disponivel = limite - realizado
        const orcamentoDiario = limite / ultimoDiaMes
        return `- ${item}: R$ ${realizado.toFixed(2)} gastos de R$ ${limite.toFixed(2)} planejado (R$ ${disponivel.toFixed(2)} disponível; orçamento diário ~R$ ${orcamentoDiario.toFixed(2)})`
    })
    // Uber e 99 não têm limite — mostra o realizado avulso pra Claude poder alertar sobre eles
    for (const item of ['Uber', '99']) {
        if (resumo.porItem[item] != null) {
            linhas.push(`- ${item}: R$ ${resumo.porItem[item].toFixed(2)} gastos este mês (SEM planejamento definido)`)
        }
    }

    return `DADOS REAIS DE HOJE (dia ${diaAtual} de ${ultimoDiaMes}, faltam ${diasRestantes} dias pra acabar o mês):
Total gasto no mês: R$ ${resumo.totalGasto.toFixed(2)}
Receita total do mês: R$ ${resumo.receitaTotal.toFixed(2)}
Saldo projetado pro fim do mês: R$ ${resumo.saldoProjetado.toFixed(2)}

Gasto por categoria/subcategoria este mês:
${linhas.join('\n')}`
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

// ───────────────────────── Orquestração ─────────────────────────

// Responde uma consulta financeira usando dados reais do mês + histórico curto.
// onStatus(msg) opcional avisa o dono pelo WhatsApp durante a coleta de dados (login demorado etc).
// Nunca lança — qualquer erro (navegador indisponível, timeout/rate limit da Claude API)
// vira uma mensagem de erro amigável, sem travar o resto do bot.
async function responderConsultaFinanceira(pergunta, { onStatus } = {}) {
    let resumo
    try {
        resumo = await plannerAgent.gerarResumoFinanceiroDiario({ onStatus })
    } catch (err) {
        console.error('❌ [Consultora] Não consegui buscar os dados do mês:', err.message)
        return '❌ Não consegui acessar seus dados financeiros agora (o navegador do Planner pode estar indisponível). Tenta de novo em instantes.'
    }

    const contexto = montarContextoDados(resumo)
    const messages = [
        ...historico,
        { role: 'user', content: `${contexto}\n\nPergunta do Maurício: ${pergunta}` },
    ]

    try {
        const resp = await anthropic.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: 500,
            system: SYSTEM_PROMPT_BASE,
            messages,
        })
        const bloco = resp.content.find(b => b.type === 'text')
        const resposta = bloco ? bloco.text.trim() : 'Não consegui pensar em uma resposta agora — tenta perguntar de outro jeito?'
        adicionarAoHistorico(pergunta, resposta)
        return resposta
    } catch (err) {
        console.error('❌ [Consultora] Erro na Claude API:', err.message)
        if (err instanceof Anthropic.RateLimitError) {
            return '⏳ Estou recebendo muitas perguntas agora — tenta de novo em alguns segundos.'
        }
        if (err instanceof Anthropic.APIConnectionError) {
            return '📡 Não consegui conectar pra analisar seu orçamento agora. Tenta de novo em instantes.'
        }
        if (err instanceof Anthropic.AuthenticationError) {
            return '❌ Problema de autenticação com a consultora financeira — avisa o Maurício pra checar a ANTHROPIC_API_KEY.'
        }
        return '❌ Não consegui consultar seu orçamento agora. Tenta de novo em instantes.'
    }
}

module.exports = {
    classificarMensagem,
    pareceConsultaFinanceira,
    responderConsultaFinanceira,
}
