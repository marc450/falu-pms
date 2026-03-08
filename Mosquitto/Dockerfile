FROM eclipse-mosquitto:2

RUN mkdir -p /mosquitto/config /mosquitto/data /mosquitto/log \
    && mosquitto_passwd -b -c /mosquitto/config/passwd EWON admin123 \
    && chmod 0700 /mosquitto/config/passwd

COPY mosquitto.conf /mosquitto/config/mosquitto.conf

EXPOSE 1883

CMD ["/usr/sbin/mosquitto", "-c", "/mosquitto/config/mosquitto.conf"]
