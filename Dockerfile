FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip procps \
 && rm -rf /var/lib/apt/lists/* && ln -sf /usr/bin/pip3 /usr/local/bin/pip3
ENV PIP_BREAK_SYSTEM_PACKAGES=1
WORKDIR /app
COPY package.json server.js ./
EXPOSE 8080
CMD ["node", "server.js"]
