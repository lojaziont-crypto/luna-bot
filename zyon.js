require('dotenv').config()

const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const { verificarNovosPedidos, coletarFaturamentoGerencial } = require('./shopee-agent')

const PEDIDOS_FILE = path.join(__dirname, 'pedidos_vistos.json')
let ultimoPedidoVisto = null

try {
    if (fs.existsSync(PEDIDOS_FILE)) {
        ultimoPedidoVisto = JSON.parse(fs.readFileSync(PEDIDOS_FILE, 'utf8')).ultimoId || null
    }
} catch {}

function salvarUltimoPedido(id) {
    fs.writeFileSync(PEDIDOS_FILE, JSON.stringify({ ultimoId: id }))
}

// Notifica Zaya (Railway) via HTTP POST /notify-order
// Configure ZAYA_URL no .env: ex. ZAYA_URL=https://luna-bot-xxxx.up.railway.app
function notifyZaya(orderId) {
    const url = process.env.ZAYA_URL
    if (!url) {
        console.log(`⚠️  [Zyon] ZAYA_URL não definida — pedido #${orderId} detectado mas Zaya não notificada`)
        console.log(`   Adicione no .env: ZAYA_URL=https://seu-app.up.railway.app`)
        return
    }

    const data = JSON.stringify({ orderId })
    let parsedUrl
    try {
        parsedUrl = new URL(`${url}/notify-order`)
    } catch {
        console.error(`❌ [Zyon] ZAYA_URL inválida: ${url}`)
        return
    }

    const lib = parsedUrl.protocol === 'https:' ? https : http
    const port = parsedUrl.port
        ? Number(parsedUrl.port)
        : parsedUrl.protocol === 'https:' ? 443 : 80

    const req = lib.request({
        hostname: parsedUrl.hostname,
        port,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
        }
    }, (res) => {
        console.log(`📨 [Zyon] Zaya notificada (HTTP ${res.statusCode}): pedido #${orderId}`)
    })

    req.on('error', (err) => {
        console.error(`❌ [Zyon] Erro ao notificar Zaya: ${err.message}`)
    })

    req.write(data)
    req.end()
}

async function checarNovosPedidos() {
    try {
        const hora = new Date().toLocaleTimeString('pt-BR')
        console.log(`\n🔍 [Zyon] Verificando pedidos... ${hora}`)

        const primeiroId = await verificarNovosPedidos()

        if (!primeiroId) {
            console.log('📦 [Zyon] Nenhum pedido encontrado na página')
            return
        }

        console.log(`🔢 [Zyon] Primeiro pedido da lista: ${primeiroId}`)

        if (!ultimoPedidoVisto) {
            ultimoPedidoVisto = primeiroId
            salvarUltimoPedido(primeiroId)
            console.log(`✅ [Zyon] Monitoramento inicializado — último pedido: ${primeiroId}`)
            return
        }

        if (primeiroId === ultimoPedidoVisto) {
            console.log('📦 [Zyon] Nenhum pedido novo')
            return
        }

        console.log(`🛍️  [Zyon] NOVO PEDIDO DETECTADO: #${primeiroId}`)
        notifyZaya(primeiroId)

        ultimoPedidoVisto = primeiroId
        salvarUltimoPedido(primeiroId)
    } catch (err) {
        console.error('❌ [Zyon] Erro ao verificar pedidos:', err.message)
    }
}

// Envia faturamento coletado para Zaya via POST /update-faturamento
function enviarFaturamentoParaZaya(fatDia, fatMes) {
    const url = process.env.ZAYA_URL
    if (!url) {
        console.log('⚠️  [Zyon] ZAYA_URL não definida — faturamento não enviado à Zaya')
        return
    }

    const data = JSON.stringify({ fatDia, fatMes })
    let parsedUrl
    try { parsedUrl = new URL(`${url}/update-faturamento`) } catch {
        console.error(`❌ [Zyon] ZAYA_URL inválida: ${url}`)
        return
    }

    const lib = parsedUrl.protocol === 'https:' ? https : http
    const port = parsedUrl.port ? Number(parsedUrl.port) : (parsedUrl.protocol === 'https:' ? 443 : 80)

    const req = lib.request({
        hostname: parsedUrl.hostname,
        port,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
        console.log(`📨 [Zyon] Faturamento enviado à Zaya (HTTP ${res.statusCode})`)
    })
    req.on('error', err => console.error(`❌ [Zyon] Erro ao enviar faturamento: ${err.message}`))
    req.write(data)
    req.end()
}

async function coletarEEnviarFaturamento() {
    try {
        console.log(`\n💰 [Zyon] Coletando faturamento — ${new Date().toLocaleTimeString('pt-BR')}`)
        const { fatDia, fatMes } = await coletarFaturamentoGerencial()

        if (fatDia || fatMes) {
            console.log(`💰 [Zyon] Faturamento OK — Dia: R$ ${fatDia || '?'}, Mês: R$ ${fatMes || '?'}`)
            enviarFaturamentoParaZaya(fatDia, fatMes)
        } else {
            console.log('⚠️  [Zyon] Faturamento não extraído — verifique debug_shopee/gerencial.png')
        }
    } catch (err) {
        console.error('❌ [Zyon] Erro ao coletar faturamento:', err.message)
    }
}

const INTERVALO_MS = 3 * 60 * 1000
const INTERVALO_FAT_MS = 30 * 60 * 1000  // faturamento a cada 30 min

console.log('⚡ Zyon iniciado — monitoramento de pedidos Shopee')
console.log(`🔁 Pedidos: a cada ${INTERVALO_MS / 60000} min | Faturamento: a cada ${INTERVALO_FAT_MS / 60000} min`)
console.log(`📡 Zaya URL: ${process.env.ZAYA_URL || '(não configurada — defina ZAYA_URL no .env)'}`)
console.log('─────────────────────────────────────────────────')

checarNovosPedidos()
coletarEEnviarFaturamento()
setInterval(checarNovosPedidos, INTERVALO_MS)
setInterval(coletarEEnviarFaturamento, INTERVALO_FAT_MS)
