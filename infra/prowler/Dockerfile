# Prowler agendado do Verax Control (T4.7): a imagem oficial, fixada por digest (o Dependabot propõe as
# atualizações), mais o entrypoint que roda conta a conta e envia o OCSF ao S3. Na tarefa Fargate roda com sistema
# de arquivos só leitura e /tmp como único diretório gravável (HOME=/tmp).
FROM prowlercloud/prowler:5.48.0@sha256:18c46f938c19f0409be29a0b39b33ac43187e6d0eabaf6371d7468cc682d875b

COPY --chown=root:root --chmod=0555 entrypoint.py /opt/verax/entrypoint.py

USER prowler
ENV HOME=/tmp TMPDIR=/tmp PYTHONDONTWRITEBYTECODE=1
ENTRYPOINT ["/home/prowler/.venv/bin/python", "/opt/verax/entrypoint.py"]
