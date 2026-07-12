// ─────────────────────────────────────────────────────────────────────────────
// zaya-memoria.js — memória persistente da consultora financeira.
// Um único arquivo JSON local (zaya_consultora_memoria.json, fora do git —
// dado pessoal do Maurício, não faz sentido versionar).
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs')
const path = require('path')

const ARQUIVO = path.join(__dirname, 'zaya_consultora_memoria.json')

// Estrutura completa com defaults — carregarMemoria() sempre mescla com isso,
// então campos novos adicionados aqui no futuro aparecem automaticamente em
// memórias já salvas, sem precisar migrar o arquivo manualmente.
function memoriaPadrao() {
    return {
        // { id, descricao, categoria, valorParcela, parcelasRestantes, parcelasTotal, criadoEm }
        parcelas: [],
        // { id, descricao, valor, vencimentoOriginal, status: 'atrasada'|'negociada'|'quitada', criadoEm, atualizadoEm }
        contasAtrasadas: [],
        // { id, descricao, categoria, subcategoria, valor, vencimento (AAAA-MM-DD), status: 'pendente'|'paga', criadoEm }
        // Contas com data de vencimento FUTURA (mês diferente do atual) — ex: "5 no cartão do
        // Thiago em outros, vai vir dia 01/08". Diferente de contasAtrasadas (que é só luz).
        contasFuturas: [],
        // { item: novoLimite } — ajustes aprovados na revisão de planejamento, mesclados
        // por cima de PLANEJAMENTO via plannerAgent.limitesPorItem(overrides).
        limitesOverride: {},
        // { chave: ISOString } — dedup dos alertas proativos já enviados, pra não repetir.
        // Chaves com mesAtual()/data embutida se repetem naturalmente todo mês/dia; chaves
        // por id (ex: conta específica) nunca repetem.
        alertasEnviados: {},
        metas: {
            luz: { status: 'pendente' }, // pendente | em_negociacao | quitando | quitado
            reservaEmergencia: { valorAtual: 0, metaMensal: 348, atualizadoEm: null },
            moto: { valorAtual: 0, valorAlvoMin: 8000, valorAlvoMax: 12000, atualizadoEm: null },
        },
        // { 'AAAA-MM': { categoria: valorGasto, ... } } — alimentado mês a mês pelo relatório mensal
        historicoGastosPorCategoria: {},
        // { diasQueGastaMais: ['sexta','sábado'], categoriasQueSempreEstouram: ['Lanche'] }
        padroes: { diasQueGastaMais: [], categoriasQueSempreEstouram: [] },
        // { id, segunda (AAAA-MM-DD), descricao, categoriaAlvo, economiaEstimada, status: 'ativo'|'concluido'|'expirado' }
        desafiosSemanais: [],
        // { data (AAAA-MM-DD), score, motivo }
        scoreHistorico: [],
        // { loja1: [{valor, data}], loja2: [...], outros: [...] }
        rendaExtra: { loja1: [], loja2: [], outros: [] },
        ultimaInteracao: null,
        ultimoDesafioGeradoEm: null, // AAAA-MM-DD da segunda-feira do último desafio gerado (evita duplicar)
        ultimoCalendarioEnviadoEm: null, // 'AAAA-MM' do último calendário mensal enviado
        ultimoRelatorioEnviadoEm: null, // 'AAAA-MM' do último relatório mensal enviado
        ultimaRevisaoOferecidaEm: null, // 'AAAA-MM' da última oferta de revisão de planejamento
    }
}

function mesclarComPadrao(bruto) {
    const padrao = memoriaPadrao()
    return {
        ...padrao,
        ...bruto,
        metas: {
            luz: { ...padrao.metas.luz, ...(bruto.metas?.luz || {}) },
            reservaEmergencia: { ...padrao.metas.reservaEmergencia, ...(bruto.metas?.reservaEmergencia || {}) },
            moto: { ...padrao.metas.moto, ...(bruto.metas?.moto || {}) },
        },
        padroes: { ...padrao.padroes, ...(bruto.padroes || {}) },
        rendaExtra: { ...padrao.rendaExtra, ...(bruto.rendaExtra || {}) },
    }
}

function carregarMemoria() {
    try {
        if (!fs.existsSync(ARQUIVO)) return memoriaPadrao()
        const bruto = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'))
        return mesclarComPadrao(bruto)
    } catch (err) {
        console.log(`⚠️  [Memória] Erro ao carregar zaya_consultora_memoria.json, usando padrão: ${err.message}`)
        return memoriaPadrao()
    }
}

function salvarMemoria(memoria) {
    try {
        fs.writeFileSync(ARQUIVO, JSON.stringify(memoria, null, 2), 'utf8')
    } catch (err) {
        console.log(`⚠️  [Memória] Erro ao salvar zaya_consultora_memoria.json: ${err.message}`)
    }
}

module.exports = { carregarMemoria, salvarMemoria, memoriaPadrao, ARQUIVO }
