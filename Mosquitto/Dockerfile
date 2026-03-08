FROM eclipse-mosquitto:2

RUN mkdir -p /mosquitto/config /mosquitto/data /mosquitto/log

COPY mosquitto.conf /mosquitto/config/mosquitto.conf

RUN mosquitto_passwd -b -c /mosquitto/config/passwd EWON admin123

RUN chmod 0700 /mosquitto/config/passwd

EXPOSE 1883

CMD ["/usr/sbin/mosquitto", "-c", "/mosquitto/config/mosquitto.conf"]