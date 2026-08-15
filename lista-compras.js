// ─────────────────────────────────────────────────────────────────────────────
// lista-compras.js — Lista de compras de mercado pessoal do Maurício (Zaya).
//
// Persistência simples em zaya_lista_compras.json: { itens: [...], atualizadoEm }.
// Ver/zerar/remover são resolvidos localmente em Zaya.js (regex, sem custo de IA);
// só "adicionar item" passa pelo Groq aqui (classificarEExtrairItens), pra decidir
// se a mensagem é mesmo um produto e extrair o(s) nome(s) — mensagens do tipo
// "detergente" ou "arroz e sabão" não têm nenhuma palavra-gatilho fixa possível.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config()

const fs = require('fs')
const path = require('path')
const Groq = require('groq-sdk')

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const LISTA_FILE = path.join(__dirname, 'zaya_lista_compras.json')

function carregarLista() {
    try {
        if (fs.existsSync(LISTA_FILE)) {
            const dados = JSON.parse(fs.readFileSync(LISTA_FILE, 'utf8'))
            if (Array.isArray(dados.itens)) return dados.itens
        }
    } catch {}
    return []
}

function salvarLista(itens) {
    fs.writeFileSync(LISTA_FILE, JSON.stringify({ itens, atualizadoEm: new Date().toISOString() }, null, 2))
}

function capitalizar(nome) {
    const n = nome.trim()
    return n.charAt(0).toUpperCase() + n.slice(1)
}

// Adiciona os itens informados, ignorando duplicados (case-insensitive) já presentes
// na lista. Retorna só os itens que de fato entraram, pra montar a confirmação.
function adicionarItens(nomes) {
    const itens = carregarLista()
    const existentesLower = new Set(itens.map(i => i.toLowerCase()))
    const adicionados = []
    for (const nomeBruto of nomes || []) {
        const nome = capitalizar(String(nomeBruto || ''))
        if (!nome || existentesLower.has(nome.toLowerCase())) continue
        itens.push(nome)
        existentesLower.add(nome.toLowerCase())
        adicionados.push(nome)
    }
    if (adicionados.length) salvarLista(itens)
    return adicionados
}

// Remove o item que bater com o termo informado — primeiro tenta igualdade exata
// (case-insensitive), depois substring nos dois sentidos (cobre "detergente" batendo
// com "Detergente em pó" e vice-versa). Retorna o nome real removido, ou null se não
// achou nada — quem chama decide o que fazer com "não achei" (ver Zaya.js).
function removerItem(termo) {
    const itens = carregarLista()
    const termoLower = String(termo || '').toLowerCase().trim()
    if (!termoLower) return null
    let idx = itens.findIndex(i => i.toLowerCase() === termoLower)
    if (idx === -1) idx = itens.findIndex(i => i.toLowerCase().includes(termoLower) || termoLower.includes(i.toLowerCase()))
    if (idx === -1) return null
    const [removido] = itens.splice(idx, 1)
    salvarLista(itens)
    return removido
}

function zerarLista() {
    salvarLista([])
}

// Mesmo formato usado tanto pra "vou no mercado" quanto pra "mostra minha lista"
// (o pedido não diferencia visual entre os dois casos, só se zera ou não depois).
function formatarListaMercado() {
    const itens = carregarLista()
    if (!itens.length) return '🛒 *Lista de compras*\n\nSua lista está vazia.'
    const linhas = itens.map(i => `- ${i}`).join('\n')
    const contagem = itens.length === 1 ? '1 item' : `${itens.length} itens`
    return `🛒 *Lista de compras*\n\n${linhas}\n\n_(${contagem})_`
}

function formatarConfirmacaoAdicionados(itens) {
    if (itens.length === 1) return `✅ ${itens[0]} adicionado à lista!`
    const ultimo = itens[itens.length - 1]
    const resto = itens.slice(0, -1)
    const juntos = resto.length ? `${resto.join(', ')} e ${ultimo}` : ultimo
    return `✅ ${juntos} adicionados à lista!`
}

// ───────────────────────── Classificação + extração (Groq) ─────────────────────────

const PROMPT_LISTA_COMPRAS = `Você decide se uma mensagem do dono de uma casa é um PRODUTO pra adicionar numa lista de compras de mercado.

Responda "ADICIONAR" quando a mensagem for:
- Só o nome de um ou mais produtos de mercado/casa (ex: "detergente", "arroz e sabão", "arroz, feijão e sabão em pó").
- Um pedido direto pra adicionar produto(s) na lista (ex: "adiciona sabão na lista", "coloca leite na lista", "põe pão na lista", "bota detergente na lista").

Responda "NAO_E_LISTA" pra QUALQUER outra coisa, mesmo mencionando compra/dinheiro/produto de outro jeito — inclusive:
- Perguntas ou dúvidas (ex: "posso comprar um sorvete?", "será que preciso de detergente?").
- Desejo/intenção de compra que não seja simplesmente nomear o produto pra lista (ex: "quero comprar um tênis novo", "vou comprar uma geladeira nova").
- Qualquer mensagem sem relação com produto de mercado/casa pra comprar.

Responda EXCLUSIVAMENTE em JSON:
{"tipo": "ADICIONAR"|"NAO_E_LISTA", "itens": ["Nome1", "Nome2"]}
"itens" só quando tipo=ADICIONAR — um item por produto mencionado, cada nome começando com maiúscula, sem incluir "na lista"/"pra lista" no texto do nome.`

// Retorna array de nomes de item (pode ter mais de um), ou null se a mensagem não é
// sobre adicionar produto à lista (ou se a chamada falhar — mais seguro não adicionar
// nada do que adicionar algo errado por engano técnico).
async function classificarEExtrairItens(texto) {
    try {
        const resp = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            max_tokens: 150,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: PROMPT_LISTA_COMPRAS },
                { role: 'user', content: texto },
            ],
        })
        const bruto = JSON.parse(resp.choices[0].message.content)
        if (bruto.tipo !== 'ADICIONAR' || !Array.isArray(bruto.itens)) return null
        const itens = bruto.itens.map(s => String(s || '').trim()).filter(Boolean)
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
    formatarConfirmacaoAdicionados,
    classificarEExtrairItens,
}
