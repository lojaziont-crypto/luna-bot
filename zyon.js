require('dotenv').config()

const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const { verificarNovosPedidos } = require('./shopee-agent')

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

const INTERVALO_MS = 3 * 60 * 1000

console.log('⚡ Zyon iniciado — monitoramento de pedidos Shopee')
console.log(`🔁 Verificação a cada ${INTERVALO_MS / 60000} minutos`)
console.log(`📡 Zaya URL: ${process.env.ZAYA_URL || '(não configurada — defina ZAYA_URL no .env)'}`)
console.log('─────────────────────────────────────────────────')

checarNovosPedidos()
setInterval(checarNovosPedidos, INTERVALO_MS)
