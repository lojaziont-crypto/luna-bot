const { execSync } = require('child_process')
const os = require('os')
const path = require('path')
const fs = require('fs')

const PROFILE_DIR = path.join(__dirname, 'shopee_profile')
const ZIP_OUT = path.join(__dirname, 'shopee_profile.zip')

if (!fs.existsSync(PROFILE_DIR)) {
    console.error('❌ shopee_profile/ não encontrada.')
    console.error('   Execute primeiro: node shopee-login.js  (local)  ou  node shopee-login-headless.js  (Railway)')
    process.exit(1)
}

if (fs.existsSync(ZIP_OUT)) {
    fs.unlinkSync(ZIP_OUT)
    console.log('🗑️  ZIP anterior removido.')
}

console.log('📦 Compactando shopee_profile/ ...')

try {
    if (os.platform() === 'win32') {
        execSync(
            `powershell -NoProfile -Command "Compress-Archive -Path '${PROFILE_DIR}' -DestinationPath '${ZIP_OUT}'"`,
            { cwd: __dirname, stdio: 'inherit' }
        )
    } else {
        execSync(`zip -r "${ZIP_OUT}" shopee_profile/`, { cwd: __dirname, stdio: 'inherit' })
    }

    const sizeMB = (fs.statSync(ZIP_OUT).size / 1024 / 1024).toFixed(1)
    console.log(`\n✅ shopee_profile.zip criado (${sizeMB} MB)`)
    console.log('\nPróximos passos no Railway:')
    console.log('  1. Crie um Volume montado em /app/shopee_profile')
    console.log('  2. No terminal do serviço: cd /app && unzip -o shopee_profile.zip')
} catch (err) {
    console.error('❌ Erro ao compactar:', err.message)
    process.exit(1)
}
