# Prowler agendado do Verax Control (T4.7): a imagem oficial, fixada por digest (o Dependabot propõe as
# atualizações), mais o entrypoint que roda conta a conta e envia o OCSF ao S3. Na tarefa Fargate roda com sistema
# de arquivos só leitura e /tmp como único diretório gravável (HOME=/tmp).
FROM prowlercloud/prowler:5.49.0@sha256:0113d8ee9d42674d1b1baf3b64505835fd2f14b0bb0ab2bbe5d4a52f49ff3d22

COPY --chown=root:root --chmod=0555 entrypoint.py /opt/verax/entrypoint.py

USER prowler
ENV HOME=/tmp TMPDIR=/tmp PYTHONDONTWRITEBYTECODE=1
ENTRYPOINT ["/home/prowler/.venv/bin/python", "/opt/verax/entrypoint.py"]
