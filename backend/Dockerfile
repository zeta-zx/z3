FROM python:3.13

WORKDIR /app

RUN apt install git -y

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src

EXPOSE 80

CMD ["uvicorn", "src.app:app", "--host", "0.0.0.0", "--port", "80"]
