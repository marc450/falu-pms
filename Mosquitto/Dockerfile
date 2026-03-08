FROM eclipse-mosquitto:2

COPY mosquitto.conf /mosquitto/config/mosquitto.conf
RUN mosquitto_passwd -b -c /mosquitto/config/passwd EWON admin123

EXPOSE 1883