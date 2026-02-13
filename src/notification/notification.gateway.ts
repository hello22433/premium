import { Inject, Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { OnEvent } from '@nestjs/event-emitter';
import { ILoginTokenValidator } from '../auth/interface/login.token.validator';
import { IUserAuthority } from '../user/interface/user.authority';
import {
  REQUIREMENT_CHANGED_EVENT,
  RequirementEventPayload,
} from '../requirement/interface/requirement.event';

interface ConnectedClient {
  userId: number;
  authority: IUserAuthority;
}

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/notifications',
})
export class NotificationGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationGateway.name);
  private connectedClients = new Map<string, ConnectedClient>();

  constructor(
    @Inject('ILoginTokenValidator')
    private readonly tokenValidator: ILoginTokenValidator,
  ) {}

  handleConnection(client: Socket) {
    try {
      const token = client.handshake.auth?.token as string;
      if (!token) {
        client.disconnect();
        return;
      }

      const user = this.tokenValidator.validateByToken(token);

      if (
        user.authority !== IUserAuthority.SUPER_ADMIN &&
        user.authority !== IUserAuthority.OPERATION_ADMIN
      ) {
        client.disconnect();
        return;
      }

      this.connectedClients.set(client.id, {
        userId: user.id,
        authority: user.authority,
      });

      this.logger.log(`클라이언트 연결: ${client.id} (userId: ${user.id})`);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.connectedClients.delete(client.id);
    this.logger.log(`클라이언트 연결 해제: ${client.id}`);
  }

  @OnEvent(REQUIREMENT_CHANGED_EVENT)
  handleRequirementChanged(payload: RequirementEventPayload) {
    for (const [socketId, clientInfo] of this.connectedClients) {
      if (clientInfo.userId === payload.actorId) {
        continue;
      }

      this.server.to(socketId).emit('requirement:changed', payload);
    }
  }
}
