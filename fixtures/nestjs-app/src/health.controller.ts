import { Controller, Get, All } from '@nestjs/common';

// Prefix-less controller: routes compose from the method decorator alone.
@Controller()
export class HealthController {
  // GET /health
  @Get('health')
  health() {
    return { ok: true };
  }

  // @All('ping') → surfaces as both GET /ping and POST /ping.
  @All('ping')
  ping() {
    return { pong: true };
  }
}
