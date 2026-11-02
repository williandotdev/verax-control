# Prowler agendado do Verax Control (T4.7): a imagem oficial, fixada por digest (o Dependabot propõe as
# atualizações), mais o entrypoint que roda conta a conta e envia o OCSF ao S3. Na tarefa Fargate roda com sistema
# de arquivos só leitura e /tmp como único diretório gravável (HOME=/tmp).
FROM prowlercloud/prowler:5.47.0@sha256:d8fcbd92aa0c3f9a012e6d69e6d62fead75b65cc373d6363527ee3463d7a147f

COPY --chown=root:root --chmod=0555 entrypoint.py /opt/verax/entrypoint.py

USER prowler
ENV HOME=/tmp TMPDIR=/tmp PYTHONDONTWRITEBYTECODE=1
ENTRYPOINT ["/home/prowler/.venv/bin/python", "/opt/verax/entrypoint.py"]
