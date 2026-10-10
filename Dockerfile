# Imagen base desde `mirror.gcr.io`, el espejo público de Docker Hub que mantiene Google, y no
# desde Docker Hub directo. Los runners de GitHub descargan sin autenticarse y Docker Hub los
# corta: el run 37993266084 del compiler falló tres veces seguidas resolviendo el `FROM` (504
# en auth.docker.io y luego 429 en registry-1.docker.io). El espejo sirve los MISMOS digests
# que Docker Hub (medido el 2026-10-09) y no pide credenciales, así que funciona igual en el CD,
# en CI y en un `docker build` local. El `library/` es obligatorio: es el namespace de las
# imágenes oficiales, que Docker Hub sobreentiende y el espejo no.

# Stage 1: Builder
FROM mirror.gcr.io/library/node:20-alpine AS builder

WORKDIR /app

# Archivos de configuración
COPY package*.json ./
COPY tsconfig*.json ./

# Instalar TODAS las dependencias (incluyendo devDependencies)
RUN npm ci

# Copiar el código fuente
COPY src/ ./src/

# Compilar TypeScript a JavaScript
RUN npm run build

# Stage 2: Production
FROM mirror.gcr.io/library/node:20-alpine AS runner

ENV NODE_ENV=production

# Instalar dumb-init para un correcto manejo de señales
RUN apk add --no-cache dumb-init

# Usar usuario no-root por seguridad
RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nodejs -G nodejs

WORKDIR /app

# Copiar package.json y package-lock.json
COPY package*.json ./

# Instalar SOLO dependencias de producción
RUN npm ci --omit=dev

# Copiar artefactos compilados desde el builder
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist

# Cambiar al usuario no-root
USER nodejs

# Exponer el puerto interno
EXPOSE 4000

# Iniciar la aplicación con dumb-init
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
