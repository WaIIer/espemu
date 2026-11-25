ARG IDF_IMAGE=espressif/idf:v5.4.2@sha256:4317595a911886e04cbc6d731315d5fc2918e510b6733fc7d03381ab2d270082
ARG NODE_IMAGE=node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:9c7f200c07e3d4a03e7249d2c16bf66a51120fb876aa2242cf31451412543289

FROM ${IDF_IMAGE} AS emulator-build
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config libglib2.0-dev libpixman-1-dev libgcrypt20-dev libslirp-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY versions.env /src/versions.env
RUN . /src/versions.env && git clone --depth 1 --branch "$QEMU_TAG" https://github.com/espressif/qemu.git qemu && test "$(git -C qemu rev-parse HEAD)" = "$QEMU_COMMIT"
COPY qemu/espemu.patch /src/espemu.patch
RUN git -C qemu apply --check /src/espemu.patch && git -C qemu apply /src/espemu.patch
RUN . /opt/esp/idf/export.sh && python -m pip install meson==1.7.0 && cd qemu && ./configure --target-list=xtensa-softmmu --disable-user --enable-gcrypt --enable-slirp --disable-sdl --disable-gtk --disable-vnc --disable-docs --disable-tools --disable-guest-agent --disable-werror --disable-capstone && ninja -C build -j 4 qemu-system-xtensa

FROM ${IDF_IMAGE} AS firmware-build
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
WORKDIR /project
COPY versions.env tools/idf-python.lock /project/
RUN . ./versions.env && test "$(git -C /opt/esp/idf rev-parse HEAD)" = "$IDF_COMMIT"
COPY firmware /project/firmware
COPY components/espemu_devices /project/firmware/components/espemu_devices
RUN . /opt/esp/idf/export.sh && python -m pip install --no-deps -r /project/idf-python.lock && cd firmware && idf.py build && cd build && esptool.py --chip esp32 merge_bin --fill-flash-size 4MB -o qemu_flash.bin @flash_args

FROM ${NODE_IMAGE} AS web-build
WORKDIR /app
COPY package.json package-lock.json /app/
RUN npm ci --no-audit --no-fund
COPY tsconfig.json playwright*.config.ts versions.env /app/
COPY frontend /app/frontend
COPY shared /app/shared
COPY server /app/server
COPY tests /app/tests
COPY tools /app/tools
COPY e2e /app/e2e
COPY soak /app/soak
COPY templates /app/templates
COPY components/espemu_devices /app/components/espemu_devices
COPY firmware/CMakeLists.txt firmware/sdkconfig.defaults firmware/espemu.json /app/firmware/
COPY firmware/main /app/firmware/main
COPY firmware/components /app/firmware/components
RUN npm run build

FROM emulator-build AS verification
WORKDIR /app
COPY --from=web-build /usr/local /usr/local
COPY --from=web-build /app /app
COPY Dockerfile /app/Dockerfile
COPY .github/skills/espemu-environment/scripts /app/.github/skills/espemu-environment/scripts
COPY --from=emulator-build /src/qemu /app/.cache/qemu
COPY --from=firmware-build /project/firmware/build /app/firmware/build
RUN ln -s /usr/local /app/.cache/node && ln -s /opt/esp/idf /app/.cache/esp-idf && ln -s /opt/esp /app/.cache/idf-tools
ENV IDF_PATH=/app/.cache/esp-idf IDF_TOOLS_PATH=/app/.cache/idf-tools PLAYWRIGHT_BROWSERS_PATH=/app/.cache/playwright
RUN npm exec -- playwright install --with-deps chromium && node --input-type=module -e 'import { chromium } from "@playwright/test"; const browser = await chromium.launch(); await browser.close();'
CMD ["bash", "tools/verify.sh"]

FROM web-build AS runtime-dependencies
RUN npm prune --omit=dev --no-audit --no-fund

FROM ${UBUNTU_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0t64 libpixman-1-0 libgcrypt20 libslirp0 zlib1g ca-certificates && rm -rf /var/lib/apt/lists/* && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin espemu
WORKDIR /app
COPY --from=web-build /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime-dependencies /app/node_modules /app/node_modules
COPY --from=web-build /app/package.json /app/package.json
COPY --from=web-build /app/dist /app/dist
COPY --from=web-build /app/server /app/server
COPY --from=web-build /app/shared /app/shared
COPY --from=emulator-build /src/qemu/build/qemu-system-xtensa /app/bin/qemu-system-xtensa
COPY --from=emulator-build /src/qemu/pc-bios/esp32-v3-rom*.bin /app/bios/
COPY --from=firmware-build /project/firmware/build/qemu_flash.bin /app/firmware/qemu_flash.bin
COPY --from=web-build /app/firmware/espemu.json /app/firmware/espemu.json
ENV HOST=0.0.0.0 PORT=4000 ESPEMU_PROJECT=/app/firmware ESPEMU_QEMU=/app/bin/qemu-system-xtensa ESPEMU_BIOS=/app/bios ESPEMU_FLASH=/app/firmware/qemu_flash.bin
USER espemu
EXPOSE 4000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s CMD ["node", "-e", "fetch('http://127.0.0.1:4000/live').then(response=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "server/index.ts"]
