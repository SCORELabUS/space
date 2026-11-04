FROM nginx:1.27.3

RUN apt-get update \
 && apt-get install -y --no-install-recommends gettext-base nano bash \
 && rm -rf /var/lib/apt/lists/*

RUN rm /etc/nginx/conf.d/default.conf

COPY nginx.conf.template /etc/nginx/templates/nginx.conf.template

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

WORKDIR /usr/src/app

ENTRYPOINT ["/entrypoint.sh"]
