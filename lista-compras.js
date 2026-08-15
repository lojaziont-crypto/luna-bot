// ─────────────────────────────────────────────────────────────────────────────
// lista-compras.js — Lista de compras de mercado pessoal do Maurício (Zaya).
//
// Persistência em zaya_lista_compras.json: { itens: [{nome, setor}], atualizadoEm }.
// Ver/zerar/remover são resolvidos localmente em Zaya.js (regex, sem custo de IA);
// só "adicionar item" passa pelo Groq aqui (classificarEExtrairItens), que numa
// única chamada decide se é produto, corrige a ortografia e classifica o setor do
// mercado (usado só pra ORDENAR a exibição — o nome do setor nunca aparece pro
// dono, ver formatarListaMercado).
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config()

const fs = require('fs')
const path = require('path')
const Groq = require('groq-sdk')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const LISTA_FILE = path.join(__dirname, 'zaya_lista_compras.json')

// Ordem de exibição — não foi especificada pelo dono, escolhida seguindo o fluxo
// comum de um mercado (perecíveis primeiro, limpeza/higiene por último).
const ORDEM_SETORES = ['Hortifruti', 'Açougue', 'Padaria', 'Laticínios', 'Mercearia', 'Bebidas', 'Limpeza', 'Higiene', 'Outros']

function capitalizar(nome) {
    const n = String(nome || '').trim()
    return n.charAt(0).toUpperCase() + n.slice(1)
}

function normalizarSetor(setor) {
    return ORDEM_SETORES.includes(setor) ? setor : 'Outros'
}

// Aceita tanto o formato antigo (item = string simples) quanto o atual
// ({nome, setor}) — arquivos já existentes de antes dessa mudança continuam
// carregando normalmente, só sem setor definido (caem em "Outros" até serem
// removidos e adicionados de novo).
function normalizarItem(item) {
    if (typeof item === 'string') {
        const nome = item.trim()
        return nome ? { nome, setor: 'Outros' } : null
    }
    if (item && typeof item === 'object' && item.nome) {
        return { nome: String(item.nome).trim(), setor: normalizarSetor(item.setor) }
    }
    return null
}

function carregarLista() {
    try {
        if (fs.existsSync(LISTA_FILE)) {
            const dados = JSON.parse(fs.readFileSync(LISTA_FILE, 'utf8'))
            if (Array.isArray(dados.itens)) return dados.itens.map(normalizarItem).filter(Boolean)
        }
    } catch {}
    return []
}

function salvarLista(itens) {
    fs.writeFileSync(LISTA_FILE, JSON.stringify({ itens, atualizadoEm: new Date().toISOString() }, null, 2))
}

// Adiciona os itens classificados ({nome, setor}), ignorando duplicados
// (case-insensitive) já presentes na lista. Retorna { adicionados, duplicados }
// (arrays de nomes) pra quem chama montar as duas mensagens possíveis.
function adicionarItens(itensClassificados) {
    const itens = carregarLista()
    const existentesLower = new Set(itens.map(i => i.nome.toLowerCase()))
    const adicionados = []
    const duplicados = []
    for (const bruto of itensClassificados || []) {
        const nome = capitalizar(bruto?.nome)
        if (!nome) continue
        const setor = normalizarSetor(bruto?.setor)
        if (existentesLower.has(nome.toLowerCase())) {
            duplicados.push(nome)
            continue
        }
        itens.push({ nome, setor })
        existentesLower.add(nome.toLowerCase())
        adicionados.push(nome)
    }
    if (adicionados.length) salvarLista(itens)
    return { adicionados, duplicados }
}

// Remove o item que bater com o termo informado — primeiro tenta igualdade exata
// (case-insensitive), depois substring nos dois sentidos (cobre "detergente" batendo
// com "Detergente em pó" e vice-versa). Retorna o nome real removido, ou null se não
// achou nada — quem chama decide o que fazer com "não achei" (ver Zaya.js).
function removerItem(termo) {
    const itens = carregarLista()
    const termoLower = String(termo || '').toLowerCase().trim()
    if (!termoLower) return null
    let idx = itens.findIndex(i => i.nome.toLowerCase() === termoLower)
    if (idx === -1) idx = itens.findIndex(i => i.nome.toLowerCase().includes(termoLower) || termoLower.includes(i.nome.toLowerCase()))
    if (idx === -1) return null
    const [removido] = itens.splice(idx, 1)
    salvarLista(itens)
    return removido.nome
}

function zerarLista() {
    salvarLista([])
}

function compararItens(a, b) {
    const diff = ORDEM_SETORES.indexOf(a.setor) - ORDEM_SETORES.indexOf(b.setor)
    if (diff !== 0) return diff
    return a.nome.localeCompare(b.nome, 'pt-BR')
}

// Mesmo formato usado tanto pra "vou no mercado" quanto pra "mostra minha lista"
// (o pedido não diferencia visual entre os dois casos, só se zera ou não depois).
// Itens são ordenados por setor internamente (compararItens) só pra agrupar produtos
// do mesmo corredor — o setor em si nunca aparece na mensagem.
function formatarListaMercado() {
    const itens = carregarLista()
    if (!itens.length) return '🛒 Lista De Compras:\n\nSua lista está vazia.'
    const ordenados = [...itens].sort(compararItens)
    const linhas = ordenados.map(i => `- ${i.nome}`).join('\n')
    const contagem = itens.length === 1 ? '1 item' : `${itens.length} itens`
    return `🛒 Lista De Compras:\n\n${linhas}\n\n(${contagem})`
}

function juntarNomes(nomes) {
    if (nomes.length === 1) return nomes[0]
    const ultimo = nomes[nomes.length - 1]
    const resto = nomes.slice(0, -1)
    return `${resto.join(', ')} e ${ultimo}`
}

// Retorna um array de 1 ou 2 mensagens: confirmação dos itens novos (se algum foi
// adicionado) e/ou aviso dos que já estavam na lista (se algum veio duplicado).
function formatarResultadoAdicao({ adicionados, duplicados }) {
    const mensagens = []
    if (adicionados.length) {
        const verbo = adicionados.length === 1 ? 'adicionado' : 'adicionados'
        mensagens.push(`✅ ${juntarNomes(adicionados)} ${verbo} à lista de compras!`)
    }
    if (duplicados.length) {
        const verbo = duplicados.length === 1 ? 'já está' : 'já estão'
        mensagens.push(`⚠️ ${juntarNomes(duplicados)} ${verbo} na sua lista de compras!`)
    }
    return mensagens
}

// ───────────────────────── Classificação + extração (Groq) ─────────────────────────

const PROMPT_LISTA_COMPRAS = `Você decide se uma mensagem do dono de uma casa é um PRODUTO pra adicionar numa lista de compras de mercado.

Responda "ADICIONAR" quando a mensagem for:
- Só o nome de um ou mais produtos de mercado/casa (ex: "detergente", "arroz e sabão", "arroz, feijão e sabão em pó"), mesmo com erro de digitação/acentuação (ex: "fejao", "sabao").
- Um pedido direto pra adicionar produto(s) na lista (ex: "adiciona sabão na lista", "coloca leite na lista", "põe pão na lista", "bota detergente na lista").

Responda "NAO_E_LISTA" pra QUALQUER outra coisa, mesmo mencionando compra/dinheiro/produto de outro jeito — inclusive:
- Perguntas ou dúvidas (ex: "posso comprar um sorvete?", "será que preciso de detergente?").
- Desejo/intenção de compra que não seja simplesmente nomear o produto pra lista (ex: "quero comprar um tênis novo", "vou comprar uma geladeira nova").
- Qualquer mensagem sem relação com produto de mercado/casa pra comprar.

Pra cada item em "ADICIONAR", retorne:
- "nome": o nome do produto CORRIGIDO ortograficamente (conserte erros de digitação/acentuação, ex: "fejao"→"Feijão", "sabao"→"Sabão", "leitte"→"Leite"), inicial maiúscula, sem incluir "na lista"/"pra lista" no texto.
- "setor": o setor do mercado onde esse produto fica, EXATAMENTE um destes valores: "Hortifruti", "Açougue", "Padaria", "Laticínios", "Mercearia", "Bebidas", "Limpeza", "Higiene", "Outros" (use "Outros" se não tiver certeza).

Responda EXCLUSIVAMENTE em JSON:
{"tipo": "ADICIONAR"|"NAO_E_LISTA", "itens": [{"nome": "...", "setor": "..."}]}`

// Retorna array de {nome, setor} (pode ter mais de um item), ou null se a mensagem
// não é sobre adicionar produto à lista (ou se a chamada falhar — mais seguro não
// adicionar nada do que adicionar algo errado por engano técnico).
async function classificarEExtrairItens(texto) {
    try {
        const resp = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            max_tokens: 200,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: PROMPT_LISTA_COMPRAS },
                { role: 'user', content: texto },
            ],
        })
        const bruto = JSON.parse(resp.choices[0].message.content)
        if (bruto.tipo !== 'ADICIONAR' || !Array.isArray(bruto.itens)) return null
        const itens = bruto.itens
            .map(it => ({ nome: capitalizar(it?.nome), setor: normalizarSetor(it?.setor) }))
            .filter(it => it.nome)
        return itens.length ? itens : null
    } catch (err) {
        console.log(`⚠️  [ListaCompras] Falha ao classificar "${texto}": ${err.message}`)
        return null
    }
}

module.exports = {
    carregarLista,
    adicionarItens,
    removerItem,
    zerarLista,
    formatarListaMercado,
    formatarResultadoAdicao,
    classificarEExtrairItens,
}
