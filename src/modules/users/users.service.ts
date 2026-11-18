import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        did: true,
        fullName: true,
        dob: true,
        studentId: true,
        school: true,
        nationalId: true,
        email: true,
        phone: true,
        address: true,
        settings: true,
        createdAt: true,
        updatedAt: true
      }
    });

    return { data: user };
  }
}
