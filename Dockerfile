# ─── Stage 1: Base ───────────────────────────────────────────────────────────
# Think base as name of the stage which we can use on other stage 
FROM node:20-alpine AS base
# Sets /app as the working directory for this stage.
# Stages that use 'FROM base AS ...' will inherit this.
WORKDIR /app

FROM base AS pnpm-base
RUN npm i -g pnpm@10.28.2

# ─── Stage 2: All Dependencies (for building) ────────────────────────────────
FROM pnpm-base AS deps
# Copy only the manifest and lockfile from the host into /app.
# Doing this before copying source code lets Docker cache the
# dependency install layer and skip it on rebuilds if these files haven't changed.
COPY package.json pnpm-lock.yaml ./ 
# --frozen-lockfile flag ensures that the versions of all deps get locked and should not change automatiaclly it should install as per there in pnpm-lock
RUN pnpm install --frozen-lockfile

# ─── Stage 3: Prod Dependencies Only (for running) ───────────────────────────
FROM pnpm-base AS prod-deps
COPY package.json pnpm-lock.yaml ./
#The prod file ensures that  no dev dependencies to be  installed this is
# crucial as after the build we dont need dev deps as we will get the compiled files  
RUN pnpm install --frozen-lockfile --prod

# ─── Stage 4: Builder ────────────────────────────────────────────────────────
FROM pnpm-base AS builder

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm run build

# ─── Stage 5: Production Runner ──────────────────────────────────────────────
FROM base AS runner
# Created a System group and user with nodejs and nestjs named  respectively and also assigning the group ids as well  
# such that we can give controlled  access to the user with in the  container as by default  user  given the root access which could be problematic as it can access the host file system as well 
# adding nestjs in the nodejs group   
# ✅ Fix 1 — added --ingroup nodejs
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 --ingroup nodejs nestjs 

# ✅ Change ownership and mode

# it means previously it is root:root now it is nestjs:nodejs where nestjs is a user and nodejs is a group and mode as 750 where  7 which is a owner permission  -> rwx  5 which is a group  ->r-x 0 -> no access to other  
# so any process which comes(in our case nestjs user ) it will check what permission the owner is having , what permission its group is having i.e nodejs 
# Even through group is node required currently but if any child user or process gets spawned it could be added inside this group which has limited access 
RUN chown nestjs:nodejs /app \
 && chmod 750 /app

# Copy only prod dependencies (no devDependencies) from the prod-deps stage
COPY --chown=nestjs:nodejs --from=prod-deps /app/node_modules ./node_modules

# Copy only the compiled output from the builder stage (no source files)
COPY --chown=nestjs:nodejs --from=builder   /app/dist         ./dist
# changing the owner ship for node_modules and dist as it is not inherited from its parent directory 
# not explicitly changing the mode  just adding them to system user and group as a safety net as by default it is given root access 
# setting the user as nestjs for this container
USER nestjs



CMD ["node", "dist/main"]