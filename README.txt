RUZZOS NET — BOT DE 500 KEYS | VERSIÓN LISTA PARA GITHUB + RENDER

ARCHIVOS
- index.html: web para GitHub Pages (contiene el inventario público de 500 keys).
- index.js: bot de Discord + API de validación.
- free-keys.json: las mismas 500 keys que están en index.html.
- package.json: dependencias y comando de inicio.
- .env.example: ejemplo de variables para ejecutar localmente.

IMPORTANTE SOBRE LAS KEYS
El HTML es público y las 500 keys se pueden copiar desde el código fuente. El bot asigna una key a cada cuenta Discord y recuerda la asignación en keys.sqlite. /key vuelve a entregar la misma key a la misma cuenta.

GITHUB
1. Crea un repositorio público en GitHub.
2. Sube a la raíz TODOS los archivos de esta carpeta, incluido index.html y free-keys.json.
3. No subas .env, keys.sqlite ni node_modules.
4. En Settings > Pages, elige Deploy from a branch, Branch main, folder /(root), y guarda.
5. Tu página estará en https://TU-USUARIO.github.io/NOMBRE-DEL-REPO/.

RENDER
1. Conecta el mismo repositorio en Render: New > Web Service.
2. Runtime: Node.
3. Root Directory: vacío (archivos en raíz).
4. Build Command: npm install
5. Start Command: npm start
6. Usa Node 22.5 o superior (el package.json ya lo declara).
7. En Environment agrega:
   DISCORD_TOKEN = token privado de tu bot
   ADMIN_IDS = tu ID numérico de Discord
   WEB_ORIGIN = https://TU-USUARIO.github.io
   FREE_KEY_DURATION = 30d
   DATA_DIR = /var/data
8. En Advanced agrega Persistent Disk con Mount Path /var/data. Es necesario para que keys.sqlite no se pierda al reiniciar o desplegar. El disco persistente de Render requiere un servicio de pago.
9. Despliega. La API queda en https://NOMBRE.onrender.com.

CONECTAR HTML CON API
1. Abre index.html en GitHub y edítalo.
2. Busca SITE_CONFIG.licenseApiUrl.
3. Cambia el valor por https://NOMBRE.onrender.com/api/validate (usa tu URL real de Render).
4. Guarda los cambios. GitHub Pages actualizará la web.

COMPROBACIONES
- Abre https://NOMBRE.onrender.com/health. Debe responder online: true.
- En Discord, el bot debe aparecer conectado y debe estar disponible /key.
- Prueba /key con tu cuenta. Repetir /key debe devolver la misma key.
- No borres ni reemplaces /var/data/keys.sqlite. Es la memoria de las asignaciones.

SEGURIDAD
Nunca subas el token de Discord ni el archivo .env a GitHub. Si el token se publica, restablécelo en Discord Developer Portal.
