import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as bodyParser from 'body-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(bodyParser.json({ limit: '15mb' }));
  app.use(bodyParser.urlencoded({ limit: '15mb', extended: true }));
  app.setGlobalPrefix('api');
  const port = Number(process.env.PORT) || 3100;
  await app.listen(port);
  console.log(`[CarrotCanvas] backend running at http://localhost:${port}`);
}

bootstrap();
